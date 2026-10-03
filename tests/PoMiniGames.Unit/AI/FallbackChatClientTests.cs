using FluentAssertions;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.AI;

namespace PoMiniGames.Unit.AI;

/// <summary>
/// The fallback is the only thing between a dead deployment and a dead game, and the two cases
/// it must NOT rescue (a spent allowance, a cancelled request) are as important as the one it does.
/// </summary>
public sealed class FallbackChatClientTests
{
    private sealed class Scripted(Func<ChatResponse> reply) : IChatClient
    {
        public int Calls { get; private set; }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            Calls++;
            return Task.FromResult(reply());
        }

        public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose() { }
    }

    private static readonly ChatMessage[] Ask = [new(ChatRole.User, "hi")];

    private static ChatResponse Says(string text) => new(new ChatMessage(ChatRole.Assistant, text));

    private static FallbackChatClient Wrap(IChatClient primary, IChatClient? fallback) =>
        new(primary, () => fallback, "test", NullLogger.Instance);

    [Fact]
    public async Task Fallback_RescuesAProviderFailure_ButNotABudgetRefusalOrADoubleFailure()
    {
        // Primary healthy: the fallback is never touched.
        var spare = new Scripted(() => Says("spare"));
        (await Wrap(new Scripted(() => Says("primary")), spare).GetResponseAsync(Ask)).Text.Should().Be("primary");
        spare.Calls.Should().Be(0);

        // Primary down: the same request is answered by the fallback.
        var down = new Scripted(() => throw new InvalidOperationException("429"));
        (await Wrap(down, spare).GetResponseAsync(Ask)).Text.Should().Be("spare");
        spare.Calls.Should().Be(1);

        // Out of allowance is the caller's state, not the deployment's: no second model.
        var broke = new Scripted(() => throw new AiTokenBudgetExceededException(10, 10, DateTimeOffset.UtcNow));
        await FluentActions.Awaiting(() => Wrap(broke, spare).GetResponseAsync(Ask))
            .Should().ThrowAsync<AiTokenBudgetExceededException>();
        spare.Calls.Should().Be(1);

        // Both down: the caller sees the FIRST failure, which names what is actually wrong.
        var alsoDown = new Scripted(() => throw new TimeoutException("fallback"));
        (await FluentActions.Awaiting(() => Wrap(down, alsoDown).GetResponseAsync(Ask))
            .Should().ThrowAsync<InvalidOperationException>()).WithMessage("429");

        // No fallback configured: behaves as if this decorator were not there.
        await FluentActions.Awaiting(() => Wrap(down, fallback: null).GetResponseAsync(Ask))
            .Should().ThrowAsync<InvalidOperationException>();
    }
}
