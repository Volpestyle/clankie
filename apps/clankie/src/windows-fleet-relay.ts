import { powershellScriptCommand } from "./herdr-fleet.ts";

/** Trusted service-authored relay. SSH stdout carries frames; client TCP carries only bytes.
 * The peer tuple is taken from AcceptTcpClient's socket, never an HTTP field. EOF closes all peers.
 */
export function windowsFleetRelayCommand(): string {
  return powershellScriptCommand(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Collections.Generic;
using System.Threading;
public static class ClankieRelay {
  static readonly object outputLock = new object();
  static readonly object clientsLock = new object();
  static readonly Dictionary<uint, TcpClient> clients = new Dictionary<uint, TcpClient>();
  static readonly Stream output = Console.OpenStandardOutput();
  static readonly Stream input = Console.OpenStandardInput();
  static TcpListener listener;
  static volatile bool stopped;
  const int MAX_FRAME = 65536;
  static void Send(byte kind, uint id, byte[] bytes, int length) {
    lock (outputLock) {
      byte[] header = new byte[9]; header[0] = kind;
      Array.Copy(BitConverter.GetBytes(id), 0, header, 1, 4);
      Array.Copy(BitConverter.GetBytes(length), 0, header, 5, 4);
      output.Write(header, 0, header.Length);
      output.Write(bytes, 0, length); output.Flush();
    }
  }
  static byte[] Read(int length) {
    byte[] bytes = new byte[length]; int offset = 0;
    while (offset < length) {
      int count = input.Read(bytes, offset, length - offset);
      if (count == 0) throw new EndOfStreamException();
      offset += count;
    }
    return bytes;
  }
  static void Close(uint id) {
    lock (clientsLock) { TcpClient client; if (clients.TryGetValue(id, out client)) {clients.Remove(id); client.Close();} }
  }
  static void Stop() {
    stopped = true;
    if (listener != null) listener.Stop();
    lock (clientsLock) { foreach (var client in clients.Values) client.Close(); clients.Clear(); }
  }
  static void Receive() {
    try {
      while (!stopped) {
        byte[] header = Read(9); byte kind = header[0]; uint id = BitConverter.ToUInt32(header, 1); int length = BitConverter.ToInt32(header, 5);
        if (id == 0 || length < 0 || length > MAX_FRAME || (kind != 2 && kind != 3) || (kind == 3 && length != 0)) throw new Exception("Invalid relay frame");
        byte[] bytes = Read(length); TcpClient client;
        lock (clientsLock) {clients.TryGetValue(id, out client);}
        if (client == null) continue;
        if (kind == 3) { Close(id); continue; }
        try {client.GetStream().Write(bytes, 0, length);} catch {Close(id);}
      }
    } catch { Stop(); }
  }
  static void Copy(uint id, TcpClient client) {
    try {
      byte[] buffer = new byte[MAX_FRAME]; int count;
      while ((count = client.GetStream().Read(buffer, 0, buffer.Length)) > 0) Send(2, id, buffer, count);
    } catch { }
    finally { Close(id); try {Send(3, id, new byte[0], 0);} catch {Stop();} }
  }
  public static void Run() {
    listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(64);
    Send(0, 0, BitConverter.GetBytes(((IPEndPoint)listener.LocalEndpoint).Port), 4);
    var reader = new Thread(Receive); reader.IsBackground = true; reader.Start();
    uint next = 0;
    try {
      while (!stopped) {
        TcpClient client = listener.AcceptTcpClient(); client.NoDelay = true;
        uint id = ++next;
        if (id == 0) {client.Close(); throw new Exception("Relay stream ids exhausted");}
        lock (clientsLock) {
          if (clients.Count >= 64) {client.Close(); continue;}
          clients.Add(id, client);
        }
        byte[] tuple = new byte[8];
        Array.Copy(BitConverter.GetBytes(((IPEndPoint)client.Client.RemoteEndPoint).Port), 0, tuple, 0, 4);
        Array.Copy(BitConverter.GetBytes(((IPEndPoint)client.Client.LocalEndPoint).Port), 0, tuple, 4, 4);
        Send(1, id, tuple, tuple.Length);
        ThreadPool.QueueUserWorkItem(delegate {Copy(id, client);});
      }
    } finally { Stop(); }
  }
}
'@
[ClankieRelay]::Run()
`);
}
