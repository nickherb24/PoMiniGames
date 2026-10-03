using Microsoft.Extensions.AI;
using Polly;

namespace PoMiniGames.AI;

/// <summary>
/// Executes every model call through the shared <see cref="AzureOpenAIResilience"/> pipeline —
/// total-call budget, jittered retry, circuit breaker.
/// </summary>
/// <remarks>
/// <para>
/// The pipeline was written, documented and registered, and then never resolved by anything: a
/// solution-wide search for <c>ResiliencePipelineProvider</c> matched only the doc comments in
/// <see cref="AzureOpenAIResilience"/> itself. The observable consequences were exactly the ones
/// it was built to prevent — a single relay call ran <b>51.6 s</b> against a documented 20 s
/// ceiling (three 15-second SDK attempts, unbounded from above), and with no circuit state the
/// game kept firing fresh calls into an endpoint that had failed 15 times in a row.
/// </para>
/// <para>
/// GoF: Decorator. Wrapping the <see cref="IChatClient"/> rather than calling the pipeline from
/// each service is what makes the guarantee structural: a new AI-consuming slice inherits the
/// posture by resolving its chat client, and cannot forget to opt in.
/// </para>
/// </remarks>
public sealed class ResilientChatClient : DelegatingChatClient
{
    private readonly ResiliencePipeline _pipeline;

    public ResilientChatClient(IChatClient innerClient, ResiliencePipeline pipeline)
        : base(innerClient)
        => _pipeline = pipeline;

    public override Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
        => _pipeline.ExecuteAsync(
            static (state, ct) => new ValueTask<ChatResponse>(
                state.Inner.GetResponseAsync(state.Messages, state.Options, ct)),
            (Inner: InnerClient, Messages: messages, Options: options),
            cancellationToken).AsTask();

    // Streaming is deliberately not wrapped: a retry mid-stream would replay tokens the caller
    // already consumed. PoJoker's streamed verdict falls back to the buffered call above, and
    // BudgetedChatClient still meters the stream.
}
