import Darwin
import Foundation

@main
enum DesktopMain {
  @MainActor
  static func main() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
      print("clankie-desktop 0.1.0")
      return
    }
    guard
      arguments == ["diagnose"] || arguments == ["session"]
        || arguments == ["session", "--allow-menu-actions"]
    else {
      print("Usage: clankie-desktop diagnose | session [--allow-menu-actions]")
      if arguments != ["--help"] { exit(2) }
      return
    }
    do {
      let driver = try NativeDesktop()
      if arguments == ["diagnose"] {
        var result = try driver.diagnose()
        result["success"] = true
        write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
        return
      }
      let session = Session(
        driver: driver, allowMenuActions: arguments.contains("--allow-menu-actions"))
      while let line = try inputLine() {
        do {
          let request = try JSONDecoder().decode(Request.self, from: line)
          write(session.respond(request))
        } catch {
          write(Data(#"{"success":false,"code":"invalid_json","retrySafe":true}"#.utf8))
        }
      }
    } catch let failure as Failure {
      write(
        (try? JSONSerialization.data(withJSONObject: [
          "success": false, "code": failure.code,
          "message": failure.message, "retrySafe": !failure.dispatched,
        ])) ?? Data())
      exit(1)
    } catch {
      write(Data(#"{"success":false,"code":"internal","retrySafe":false}"#.utf8))
      exit(1)
    }
  }

  static func inputLine() throws -> Data? {
    var data = Data()
    var byte: UInt8 = 0
    while true {
      let count = Darwin.read(STDIN_FILENO, &byte, 1)
      if count < 0 {
        if errno == EINTR { continue }
        throw Failure(code: "stdin_error", message: "Could not read request")
      }
      if count == 0 { return data.isEmpty ? nil : data }
      if byte == 10 { return data }
      guard data.count < 16384 else {
        throw Failure(code: "input_limit", message: "Request exceeds 16384 bytes")
      }
      data.append(byte)
    }
  }

  static func write(_ data: Data) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}
