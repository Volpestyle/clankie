package io.clankie.verifier;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class Hashing {
  static final String ZERO_SHA256 = "0".repeat(64);

  private Hashing() {}

  static String sha256(byte[] bytes) {
    try {
      var digest = MessageDigest.getInstance("SHA-256").digest(bytes);
      var result = new StringBuilder(64);
      for (byte value : digest) result.append(String.format("%02x", value));
      return result.toString();
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 is required by the JVM", error);
    }
  }

  static String sha256(String value) {
    return sha256(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }

  static String sha256(Path path) throws IOException {
    return sha256(Files.readAllBytes(path));
  }
}
