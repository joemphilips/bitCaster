using System.Text.Json;
using System.Text.Json.Serialization;

namespace BitCaster.MatchingEngine.Contracts.Domain;

/// <summary>
/// A non-negative amount of satoshis (>= 0).
/// Serializes as a plain JSON number.
/// </summary>
[JsonConverter(typeof(SatsJsonConverter))]
public readonly record struct Sats : IComparable<Sats>
{
    /// <summary>The underlying satoshi value. Always >= 0.</summary>
    public long Value { get; }

    public Sats(long value)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(value);
        Value = value;
    }

    public static Sats Zero => new(0);

    public int CompareTo(Sats other) => Value.CompareTo(other.Value);

    public static Sats operator +(Sats a, Sats b) => new(a.Value + b.Value);
    public static Sats operator -(Sats a, Sats b) => new(a.Value - b.Value);
    public static bool operator >(Sats a, Sats b) => a.Value > b.Value;
    public static bool operator <(Sats a, Sats b) => a.Value < b.Value;
    public static bool operator >=(Sats a, Sats b) => a.Value >= b.Value;
    public static bool operator <=(Sats a, Sats b) => a.Value <= b.Value;
    public static Sats Min(Sats a, Sats b) => a.Value <= b.Value ? a : b;

    public override string ToString() => Value.ToString();
}

/// <summary>
/// A probability price in the range [1, 99] representing a percentage chance.
/// Used for limit order prices in binary outcome markets.
/// Serializes as a plain JSON number.
/// </summary>
[JsonConverter(typeof(ProbabilityJsonConverter))]
public readonly record struct Probability : IComparable<Probability>
{
    /// <summary>The price value. Always in the range [1, 99].</summary>
    public int Value { get; }

    public Probability(int value)
    {
        if (value is < 1 or > 99)
            throw new ArgumentOutOfRangeException(nameof(value), value, "Probability must be between 1 and 99.");
        Value = value;
    }

    /// <summary>Returns the complementary probability (100 - this).</summary>
    public Probability Complement() => new(100 - Value);

    public int CompareTo(Probability other) => Value.CompareTo(other.Value);

    public static bool operator >(Probability a, Probability b) => a.Value > b.Value;
    public static bool operator <(Probability a, Probability b) => a.Value < b.Value;
    public static bool operator >=(Probability a, Probability b) => a.Value >= b.Value;
    public static bool operator <=(Probability a, Probability b) => a.Value <= b.Value;
    public static int operator +(Probability a, Probability b) => a.Value + b.Value;
    public static int operator -(Probability a, Probability b) => a.Value - b.Value;

    public override string ToString() => Value.ToString();
}

internal sealed class SatsJsonConverter : JsonConverter<Sats>
{
    public override Sats Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        new(reader.GetInt64());

    public override void Write(Utf8JsonWriter writer, Sats value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value.Value);
}

internal sealed class ProbabilityJsonConverter : JsonConverter<Probability>
{
    public override Probability Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        new(reader.GetInt32());

    public override void Write(Utf8JsonWriter writer, Probability value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(value.Value);
}
