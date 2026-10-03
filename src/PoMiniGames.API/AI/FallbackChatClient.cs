using Microsoft.Extensions.AI;

namespace PoMiniGames.AI;

/// <summary>
/// Retries a failed model call once on a second deployment.
/// </summary>
/// <remarks>
/// <para>
/// The resilience pipeline retries the SAME deployment, which is the right answer to a blip and
/// no answer at all to a deployment that is rate limited, removed or has its circuit open. This
/// sits outside that pipeline: only when the primary has given up does the call go to the
/// fallback, through the fallback's own decorated client, so the second attempt is budgeted,
/// timed and recorded exactly like the first.
/// </para>
/// <para>
/// Off unless <see cref="AIFoundryOptions.FallbackDeployment"/> is set. The fallback receives the
/// <see cref="ChatOptions"/> built for the primary, so it should be a model of the same capability
/// class (both able to take a JSON schema, for instance); if it rejects them the original failure
/// is what the caller sees.
/// </para>
/// <para>
/// Streaming is not covered, for the reason <see cref="ResilientChatClient"/> gives: a second
/// attempt mid-stream would replay tokens the caller already consumed.
/// </para>
/// </remarks>
public sealed class FallbackChatClient : DelegatingChatClient
{
    private readonly Func<IChatClient?> _fallback;
    private readonly ILogger _logger;
    private readonly string _game;

    public FallbackChatClient(IChatClient primary, Func<IChatClient?> fallback, string game, ILogger logger)
        : base(primary)
    {
        _fallback = fallback;
        _game = game;
        _logger = logger;
    }

    public override async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        // Materialised once: the sequence is read by the primary and may be read again here.
        var history = messages as IReadOnlyList<ChatMessage> ?? messages.ToList();
        try
        {
            return await base.GetResponseAsync(history, options, cancellationToken);
        }
        // Not the caller's own cancellation, and not "out of allowance": a second model does
        // not un-cancel a request or give a player more budget.
        catch (Exception ex) when (ex is not AiTokenBudgetExceededException
                                   && !cancellationToken.IsCancellationRequested
                                   && _fallback() is { } fallback)
        {
            _logger.LogWarning(ex, "AI call for {Game} failed on its primary deployment; trying the fallback.", _game);
            try
            {
                return await fallback.GetResponseAsync(history, options, cancellationToken);
            }
            catch (Exception second) when (second is not OperationCanceledException)
            {
                _logger.LogWarning(second, "AI fallback for {Game} failed too.", _game);
                // The first failure is the one that describes what is actually wrong.
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex).Throw();
                throw;
            }
        }
    }
}
