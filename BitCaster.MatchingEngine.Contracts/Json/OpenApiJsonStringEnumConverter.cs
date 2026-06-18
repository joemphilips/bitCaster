using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.Serialization;

namespace BitCaster.MatchingEngine.Contracts.Json;

/// <summary>
/// Contract-owned replacement for NSwag's parameterless enum converter
/// attributes. The parameterless System.Text.Json converter ignores
/// <see cref="EnumMemberAttribute"/> and writes enum member names verbatim;
/// this converter keeps generated DTO producers aligned with the exact
/// OpenAPI enum literals generated into <see cref="EnumMemberAttribute"/>.
/// </summary>
public sealed class OpenApiJsonStringEnumConverter<TEnum> : JsonConverterFactory
    where TEnum : struct, Enum
{
    private static readonly Dictionary<TEnum, string> ToWire = BuildToWire();
    private static readonly Dictionary<string, TEnum> FromWireCaseInsensitive =
        ToWire.ToDictionary(kvp => kvp.Value, kvp => kvp.Key, StringComparer.OrdinalIgnoreCase);

    public override bool CanConvert(Type typeToConvert) =>
        typeToConvert == typeof(TEnum)
        || Nullable.GetUnderlyingType(typeToConvert) == typeof(TEnum);

    public override JsonConverter CreateConverter(
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        if (typeToConvert == typeof(TEnum))
            return new EnumMemberConverter();
        if (Nullable.GetUnderlyingType(typeToConvert) == typeof(TEnum))
            return new NullableEnumMemberConverter();

        throw new InvalidOperationException(
            $"{nameof(OpenApiJsonStringEnumConverter<TEnum>)} cannot convert {typeToConvert}.");
    }

    private sealed class EnumMemberConverter : JsonConverter<TEnum>
    {
        public override TEnum Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            if (reader.TokenType != JsonTokenType.String)
                throw new JsonException($"Expected string token for {typeof(TEnum).Name}.");

            return ReadWireValue(reader.GetString());
        }

        public override void Write(
            Utf8JsonWriter writer,
            TEnum value,
            JsonSerializerOptions options) =>
            WriteWireValue(writer, value);
    }

    private sealed class NullableEnumMemberConverter : JsonConverter<TEnum?>
    {
        public override TEnum? Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            if (reader.TokenType == JsonTokenType.Null)
                return null;
            if (reader.TokenType != JsonTokenType.String)
                throw new JsonException($"Expected string token for {typeof(TEnum).Name}.");

            return ReadWireValue(reader.GetString());
        }

        public override void Write(
            Utf8JsonWriter writer,
            TEnum? value,
            JsonSerializerOptions options)
        {
            if (value is null)
            {
                writer.WriteNullValue();
                return;
            }

            WriteWireValue(writer, value.Value);
        }
    }

    private static TEnum ReadWireValue(string? value)
    {
        if (value is not null && FromWireCaseInsensitive.TryGetValue(value, out var parsed))
            return parsed;

        throw new JsonException($"Unknown {typeof(TEnum).Name} value: {value}");
    }

    private static void WriteWireValue(Utf8JsonWriter writer, TEnum value)
    {
        if (!ToWire.TryGetValue(value, out var wireValue))
            throw new JsonException($"Unknown {typeof(TEnum).Name} value: {value}");
        writer.WriteStringValue(wireValue);
    }

    private static Dictionary<TEnum, string> BuildToWire()
    {
        var result = new Dictionary<TEnum, string>();
        foreach (var value in Enum.GetValues<TEnum>())
        {
            var name = Enum.GetName(value);
            if (name is null) continue;

            var member = typeof(TEnum).GetMember(name).SingleOrDefault();
            var attribute = member?.GetCustomAttributes(typeof(EnumMemberAttribute), false)
                .OfType<EnumMemberAttribute>()
                .SingleOrDefault();
            result[value] = attribute?.Value ?? name;
        }

        return result;
    }
}
