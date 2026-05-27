using System.Collections.Concurrent;
using BitCaster.MatchingEngine.Contracts;

namespace BitCaster.InMemoryMatchingEngine;

public sealed class InMemoryCommentStore
{
    private readonly ConcurrentDictionary<string, MarketComment> _visibleByKey = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<Guid, NostrKind1Event> _commentsByOrder = new();
    private readonly ConcurrentDictionary<Guid, List<Fill>> _fillsByOrder = new();

    public void RecordComment(string conditionId, Guid orderId, NostrKind1Event comment)
    {
        _commentsByOrder[orderId] = comment;
        if (_fillsByOrder.TryGetValue(orderId, out var fills))
        {
            lock (fills)
            {
                foreach (var fill in fills)
                {
                    Project(conditionId, orderId, comment, fill);
                }
            }
        }
    }

    public void RecordFill(string conditionId, Fill fill)
    {
        RecordFillForOrder(fill.MakerOrderId, fill);
        RecordFillForOrder(fill.TakerOrderId, fill);
        if (_commentsByOrder.TryGetValue(fill.MakerOrderId, out var makerComment))
            Project(conditionId, fill.MakerOrderId, makerComment, fill);
        if (_commentsByOrder.TryGetValue(fill.TakerOrderId, out var takerComment))
            Project(conditionId, fill.TakerOrderId, takerComment, fill);
    }

    public MarketCommentsResponse Get(string conditionId)
    {
        var comments = _visibleByKey.Values
            .Where(comment => comment.AdditionalProperties.TryGetValue("conditionId", out var raw)
                              && raw is string value
                              && string.Equals(value, conditionId, StringComparison.Ordinal))
            .OrderBy(comment => comment.Timestamp)
            .ThenBy(comment => comment.CommentId)
            .Select(comment => new MarketComment(comment.CommentId, comment.Content, comment.Timestamp))
            .ToList();
        return new MarketCommentsResponse(comments, conditionId);
    }

    private void RecordFillForOrder(Guid orderId, Fill fill)
    {
        var fills = _fillsByOrder.GetOrAdd(orderId, _ => []);
        lock (fills)
        {
            if (fills.Any(existing => existing.Id == fill.Id)) return;
            fills.Add(fill);
        }
    }

    private void Project(string conditionId, Guid orderId, NostrKind1Event comment, Fill fill)
    {
        var key = $"{comment.Id}:{fill.Id}";
        _visibleByKey.GetOrAdd(key, _ =>
        {
            var visible = new MarketComment(
                DeterministicGuid(key),
                comment.Content,
                DateTimeOffset.FromUnixTimeSeconds(comment.CreatedAt));
            visible.AdditionalProperties["conditionId"] = conditionId;
            return visible;
        });
    }

    private static Guid DeterministicGuid(string value)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return new Guid(hash.AsSpan(0, 16));
    }
}
