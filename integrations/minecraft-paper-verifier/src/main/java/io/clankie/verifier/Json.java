package io.clankie.verifier;

import java.lang.reflect.Array;
import java.util.Map;

final class Json {
  private Json() {}

  static String encode(Object value) {
    var output = new StringBuilder();
    append(output, value);
    return output.toString();
  }

  private static void append(StringBuilder output, Object value) {
    if (value == null) {
      output.append("null");
    } else if (value instanceof String string) {
      appendString(output, string);
    } else if (value instanceof Number || value instanceof Boolean) {
      output.append(value);
    } else if (value instanceof Enum<?> enumValue) {
      appendString(output, enumValue.name());
    } else if (value instanceof Map<?, ?> map) {
      output.append('{');
      var first = true;
      var entries = map.entrySet().stream().sorted(
          java.util.Comparator.comparing(entry -> String.valueOf(entry.getKey()))).toList();
      for (var entry : entries) {
        if (!first) output.append(',');
        first = false;
        appendString(output, String.valueOf(entry.getKey()));
        output.append(':');
        append(output, entry.getValue());
      }
      output.append('}');
    } else if (value instanceof Iterable<?> iterable) {
      output.append('[');
      var first = true;
      for (var item : iterable) {
        if (!first) output.append(',');
        first = false;
        append(output, item);
      }
      output.append(']');
    } else if (value.getClass().isArray()) {
      output.append('[');
      for (var index = 0; index < Array.getLength(value); index++) {
        if (index > 0) output.append(',');
        append(output, Array.get(value, index));
      }
      output.append(']');
    } else {
      throw new IllegalArgumentException("Unsupported JSON value: " + value.getClass().getName());
    }
  }

  private static void appendString(StringBuilder output, String value) {
    output.append('"');
    for (var index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      switch (character) {
        case '"' -> output.append("\\\"");
        case '\\' -> output.append("\\\\");
        case '\b' -> output.append("\\b");
        case '\f' -> output.append("\\f");
        case '\n' -> output.append("\\n");
        case '\r' -> output.append("\\r");
        case '\t' -> output.append("\\t");
        default -> {
          if (character < 0x20) output.append(String.format("\\u%04x", (int) character));
          else output.append(character);
        }
      }
    }
    output.append('"');
  }
}
