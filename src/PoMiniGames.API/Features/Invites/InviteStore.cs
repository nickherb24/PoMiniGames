using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using PoMiniGames.Features.MatchHistory;

namespace PoMiniGames.Features.Invites;

/// <summary>A game invite waiting for its recipient's device to ask for it.</summary>
public sealed record PendingInvite(string From, string Game, string Title, string Url, DateTimeOffset SentAtUtc);

/// <summary>The server's VAPID key pair: the public half goes to browsers, the private half signs pushes.</summary>
public sealed record VapidKeys(string PublicKey, byte[] PrivateKeyPkcs8);

/// <summary>
/// Table Storage behind invites: who has push turned on, which invites are waiting, and the
/// VAPID key pair. One table, three kinds of partition, the way <c>MatchHistory</c> keeps its
/// dedup markers beside its records.
/// </summary>
/// <remarks>
/// <para>
/// <b>People are addressed by display name</b>, because that is the only handle a head-to-head
/// row has: <see cref="MatchRecordEntity"/> stores an opponent's name, not an id. A subscription
/// is filed under the same key <see cref="MatchHistoryRepository.OwnerKey"/> gives that name, so
/// "invite the person in this row" resolves without a second identity scheme. Two players with one
/// name share invites; an invite carries only the sender's name and a link into this app.
/// </para>
/// <para>
/// <b>The VAPID key pair provisions itself</b> on first use and lives in the table, not in Key
/// Vault. A push subscription is bound to the key it was created with, so the pair must be stable
/// across recycles, and nothing has to be created by hand for push to work in a new environment.
/// It sits beside the data-protection key ring, which the same storage account already holds.
/// Losing the table only costs the existing subscriptions, which re-subscribe on the next visit.
/// </para>
/// <para>Degrades like every other store here: reads come back empty and writes are skipped.</para>
/// </remarks>
public sealed class InviteStore(TableServiceClient tables, ILogger<InviteStore> logger)
{
    /// <summary>Table name. Ensured at startup by <c>StorageInitializer</c>.</summary>
    public const string TableName = "PushInvites";

    /// <summary>How long an invite is offered to the recipient's device.</summary>
    public static readonly TimeSpan InviteLifetime = TimeSpan.FromMinutes(10);

    /// <summary>Devices kept per person. The oldest go first.</summary>
    internal const int MaxSubscriptionsPerOwner = 5;

    private const string VapidPartition = "vapid";
    private const string VapidRow = "key";

    private readonly TableClient _table = tables.GetTableClient(TableName);
    private readonly SemaphoreSlim _vapidGate = new(1, 1);
    private VapidKeys? _vapid;
    private bool _ensured;

    // ── VAPID key pair ───────────────────────────────────────────────────

    /// <summary>The key pair, created on first use. Null when storage is unreachable.</summary>
    public async Task<VapidKeys?> GetVapidKeysAsync(CancellationToken ct = default)
    {
        if (_vapid is not null) return _vapid;
        await _vapidGate.WaitAsync(ct);
        try
        {
            if (_vapid is not null) return _vapid;
            await EnsureTableAsync(ct);

            var existing = await _table.GetEntityIfExistsAsync<TableEntity>(VapidPartition, VapidRow, cancellationToken: ct);
            if (!existing.HasValue)
            {
                using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                var q = key.ExportParameters(false).Q;
                // The uncompressed point (0x04 || X || Y) is the form PushManager.subscribe takes.
                var publicKey = Base64Url(Pad32(q.X!).Prepend((byte)4).Concat(Pad32(q.Y!)).ToArray());
                try
                {
                    await _table.AddEntityAsync(new TableEntity(VapidPartition, VapidRow)
                    {
                        ["PublicKey"] = publicKey,
                        ["PrivateKey"] = Convert.ToBase64String(key.ExportPkcs8PrivateKey()),
                    }, ct);
                }
                catch (RequestFailedException ex) when (ex.Status == 409)
                {
                    // Another host won the race; its pair is the one browsers will be given.
                }
                existing = await _table.GetEntityIfExistsAsync<TableEntity>(VapidPartition, VapidRow, cancellationToken: ct);
            }

            if (existing.Value is not { } row) return null;
            _vapid = new VapidKeys(row.GetString("PublicKey") ?? "", Convert.FromBase64String(row.GetString("PrivateKey") ?? ""));
            return _vapid;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "VAPID keys unavailable; push is off until storage answers.");
            return null;
        }
        finally
        {
            _vapidGate.Release();
        }
    }

    // ── Subscriptions ────────────────────────────────────────────────────

    public async Task<bool> SubscribeAsync(string owner, string endpoint, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            var partition = Partition("sub", owner);
            await _table.UpsertEntityAsync(
                new TableEntity(partition, Hash(endpoint)) { ["Endpoint"] = endpoint }, TableUpdateMode.Replace, ct);

            // A browser that re-subscribes gets a new endpoint, so a person collects dead rows
            // over time. Keep the newest few; the dead ones would only be found by pushing to them.
            var rows = new List<TableEntity>();
            await foreach (var row in _table.QueryAsync<TableEntity>(e => e.PartitionKey == partition, cancellationToken: ct))
                rows.Add(row);
            foreach (var stale in rows.OrderByDescending(r => r.Timestamp).Skip(MaxSubscriptionsPerOwner))
                await _table.DeleteEntityAsync(stale.PartitionKey, stale.RowKey, ETag.All, ct);
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Push subscription was not saved.");
            return false;
        }
    }

    public async Task UnsubscribeAsync(string owner, string endpoint, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            await _table.DeleteEntityAsync(Partition("sub", owner), Hash(endpoint), ETag.All, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Push subscription was not removed.");
        }
    }

    public async Task<IReadOnlyList<string>> GetEndpointsAsync(string owner, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            var partition = Partition("sub", owner);
            var endpoints = new List<string>();
            await foreach (var row in _table.QueryAsync<TableEntity>(e => e.PartitionKey == partition, cancellationToken: ct))
                if (row.GetString("Endpoint") is { Length: > 0 } endpoint) endpoints.Add(endpoint);
            return endpoints;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Push subscriptions could not be read.");
            return [];
        }
    }

    // ── Pending invites ──────────────────────────────────────────────────

    public async Task AddInviteAsync(string recipient, PendingInvite invite, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            // Reverse-chronological RowKey, as MatchHistory does: newest first without a sort.
            var inverse = (DateTimeOffset.MaxValue.Ticks - invite.SentAtUtc.Ticks).ToString("D19");
            await _table.AddEntityAsync(new TableEntity(Partition("inv", recipient), $"{inverse}-{Guid.NewGuid():N}")
            {
                ["From"] = invite.From,
                ["Game"] = invite.Game,
                ["Title"] = invite.Title,
                ["Url"] = invite.Url,
                ["SentAtUtc"] = invite.SentAtUtc,
            }, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Invite was not stored.");
        }
    }

    /// <summary>Invites sent to <paramref name="recipient"/> inside <see cref="InviteLifetime"/>, newest first.</summary>
    public async Task<IReadOnlyList<PendingInvite>> GetPendingAsync(string recipient, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            var partition = Partition("inv", recipient);
            var cutoff = DateTimeOffset.UtcNow - InviteLifetime;
            var pending = new List<PendingInvite>();
            await foreach (var row in _table.QueryAsync<TableEntity>(e => e.PartitionKey == partition, maxPerPage: 20, cancellationToken: ct))
            {
                var sentAt = row.GetDateTimeOffset("SentAtUtc") ?? DateTimeOffset.MinValue;
                // Stale rows are swept here, where they are already in hand: a partition is only
                // ever read by its own recipient, so nothing else would remove them.
                if (sentAt < cutoff)
                {
                    await _table.DeleteEntityAsync(row.PartitionKey, row.RowKey, ETag.All, ct);
                    continue;
                }
                if (pending.Count < 5)
                    pending.Add(new PendingInvite(row.GetString("From") ?? "", row.GetString("Game") ?? "",
                        row.GetString("Title") ?? "", row.GetString("Url") ?? "", sentAt));
            }
            return pending;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Pending invites could not be read.");
            return [];
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private async Task EnsureTableAsync(CancellationToken ct)
    {
        if (_ensured) return;
        await _table.CreateIfNotExistsAsync(ct);
        _ensured = true;
    }

    /// <summary>
    /// One partition per person and kind. The name is normalised the way match history normalises
    /// it and then hashed, so the key is Table-safe and needs no escaping in a filter.
    /// </summary>
    private static string Partition(string kind, string owner) =>
        $"{kind}:{Hash(MatchHistoryRepository.OwnerKey(owner))[..32]}";

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static byte[] Pad32(byte[] value) =>
        value.Length == 32 ? value : [.. new byte[32 - value.Length], .. value];

    internal static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
