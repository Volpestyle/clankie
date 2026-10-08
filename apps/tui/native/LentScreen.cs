// Clankie's own Windows lent-screen host. Apache-2.0.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public sealed class ClankieLentScreen : Form {
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size; public uint tick; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first,IntPtr second);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput value);
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder value, int max);
    delegate bool EnumWindow(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
    [StructLayout(LayoutKind.Sequential)] struct NativeInput { public uint type; public Union value; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public uint key, scan, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point point; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct RawDevice { public ushort page, usage; public uint flags; public IntPtr target; }
    [StructLayout(LayoutKind.Sequential)] struct RawHeader { public uint type, size; public IntPtr device, param; }
    [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterRawInputDevices(RawDevice[] devices, uint count, uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr input, uint command, out RawHeader data, ref uint size, uint headerSize);
    bool rawObserver;
    protected override void WndProc(ref Message message) {
        if(message.Msg==0xff && consent) {
            RawHeader header; uint size=(uint)Marshal.SizeOf(typeof(RawHeader));
            if(GetRawInputData(message.LParam,0x10000005,out header,ref size,(uint)Marshal.SizeOf(typeof(RawHeader)))==UInt32.MaxValue) drainUnknown=true;
            foreign++; lastPerson=Stopwatch.GetTimestamp(); Fence();
        }
        base.WndProc(ref message);
    }
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int type, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, NativeInput[] values, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 24 * 1024 * 1024 };
    readonly Label label = new Label { Left=12, Top=12, Width=370, Height=40 };
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval=100 };
    readonly Dictionary<string, Snapshot> snapshots = new Dictionary<string, Snapshot>();
    string session="", lease="";
    bool consent, input, injected, busy, nativeBusy, drainUnknown;
    long foreign, baseline, lastPerson;
    IntPtr keyboardHook, mouseHook;
    Hook keyboardCallback, mouseCallback;
    readonly Dictionary<ulong,int> pending = new Dictionary<ulong,int>();
    readonly RandomNumberGenerator identities = RandomNumberGenerator.Create();
    ushort? heldKey;
    bool heldButton;
    long heartbeat;

    sealed class Snapshot {
        public IntPtr window; public int pid; public DateTime launched; public Rect bounds; public long captured;
        public AutomationElement root;
        public Dictionary<string, AutomationElement> elements = new Dictionary<string, AutomationElement>();
        public Dictionary<string, string> labels = new Dictionary<string, string>();
    }
    static Dictionary<string,object> Obj(params object[] pairs) {
        var result = new Dictionary<string,object>();
        for(int i=0;i<pairs.Length;i+=2) result.Add((string)pairs[i],pairs[i+1]);
        return result;
    }
    void Reply(string id, bool ok, object value) { Console.WriteLine(json.Serialize(Obj("id",id,"ok",ok,"result",value))); }
    void Fence() {
        bool was = consent;
        consent=false; input=false; snapshots.Clear(); label.Text="🐾 Clankie stopped · lease may be held";
        if(was) Console.WriteLine("{\"event\":\"stopped\"}");
    }
    bool ObserverReady() { return rawObserver && keyboardHook!=IntPtr.Zero && mouseHook!=IntPtr.Zero && !drainUnknown; }
    void Acknowledge(ulong identity, int message, bool own) {
        int expected;
        if(own && pending.TryGetValue(identity,out expected) && expected==message) pending.Remove(identity);
        else { foreign++; lastPerson=Stopwatch.GetTimestamp(); Fence(); }
    }
    bool InstallObserver() {
        if(ObserverReady()) return true;
        if(keyboardHook!=IntPtr.Zero || mouseHook!=IntPtr.Zero) { drainUnknown=true; return false; }
        keyboardCallback=(code,message,data)=> {
            if(code==0) { var value=(KeyboardHook)Marshal.PtrToStructure(data,typeof(KeyboardHook)); Acknowledge(value.extra.ToUInt64(),message.ToInt32(),(value.flags&16)!=0); }
            return CallNextHookEx(keyboardHook,code,message,data);
        };
        mouseCallback=(code,message,data)=> {
            if(code==0) { var value=(MouseHook)Marshal.PtrToStructure(data,typeof(MouseHook)); Acknowledge(value.extra.ToUInt64(),message.ToInt32(),(value.flags&1)!=0); }
            return CallNextHookEx(mouseHook,code,message,data);
        };
        rawObserver=RegisterRawInputDevices(new[]{new RawDevice {page=1,usage=6,flags=256,target=Handle},new RawDevice {page=1,usage=2,flags=256,target=Handle}},2,(uint)Marshal.SizeOf(typeof(RawDevice)));
        if(!rawObserver) return false;
        var module=GetModuleHandle(null);
        keyboardHook=SetWindowsHookEx(13,keyboardCallback,module,0);
        mouseHook=SetWindowsHookEx(14,mouseCallback,module,0);
        return ObserverReady();
    }
    object StopProof() {
        // Low-level hooks run BEFORE target queue insertion. Never claim drain after an effect.
        bool clean=ObserverReady() && !injected && !busy && !nativeBusy && pending.Count==0 && !heldKey.HasValue && !heldButton;
        return Obj("quiescent",clean,"session",session,"leaseId",lease,"observer",ObserverReady(),
            "uncertain",drainUnknown || injected,"pending",pending.Count,"held",(heldKey.HasValue?1:0)+(heldButton?1:0),"busy",busy || nativeBusy);
    }
    async Task Post(NativeInput value, int expected, bool cleanup) {
        if(!cleanup && (!ObserverReady() || !consent)) throw new InvalidOperationException();
        ulong identity; var identityBytes=new byte[8]; do { identities.GetBytes(identityBytes); identity=BitConverter.ToUInt64(identityBytes,0); } while(identity==0 || pending.ContainsKey(identity));
        pending.Add(identity,expected);
        if(value.type==1) value.value.keyboard.extra=new UIntPtr(identity); else value.value.mouse.extra=new UIntPtr(identity);
        injected=true;
        if(SendInput(1,new[]{value},Marshal.SizeOf(typeof(NativeInput)))!=1) { drainUnknown=true; throw new InvalidOperationException(); }
        long deadline=Stopwatch.GetTimestamp()+Stopwatch.Frequency;
        while(pending.ContainsKey(identity)) {
            if(!ObserverReady() || Stopwatch.GetTimestamp()>=deadline) { drainUnknown=true; throw new InvalidOperationException(); }
            await Task.Delay(5);
        }
    }
    NativeInput KeyEvent(ushort key, bool up) { return new NativeInput {type=1,value=new Union {keyboard=new Keyboard {key=key,flags=(up?2u:0u)|((key>=33 && key<=40)?1u:0u)}}}; }
    NativeInput MouseEvent(uint flags, Point at, uint data, bool move) {
        var mouse=new Mouse {flags=flags,data=data};
        if(move) {
            int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
            if(width<=1 || height<=1 || at.x<left || at.y<top || at.x>=left+width || at.y>=top+height) throw new InvalidOperationException();
            mouse.x=(int)Math.Round((at.x-left)*65535.0/(width-1)); mouse.y=(int)Math.Round((at.y-top)*65535.0/(height-1));
            mouse.flags|=0x8001u|0x4000u;
        }
        return new NativeInput {type=0,value=new Union {mouse=mouse}};
    }
    async Task CleanupInput() {
        try {
            if(heldKey.HasValue) { await Post(KeyEvent(heldKey.Value,true),0x101,true); heldKey=null; }
            if(heldButton) { Point at; if(!GetCursorPos(out at)) throw new InvalidOperationException(); await Post(MouseEvent(4,at,0,false),0x202,true); heldButton=false; }
        } catch { drainUnknown=true; }
    }
    void RawCheck(Snapshot snapshot,string token) {
        Rect bounds; uint pid; GetWindowThreadProcessId(snapshot.window,out pid);
        var focused=AutomationElement.FocusedElement;
        if(!Valid(token,true) || GetForegroundWindow()!=snapshot.window || pid!=snapshot.pid ||
            !GetWindowRect(snapshot.window,out bounds) || !Same(bounds,snapshot.bounds) || App(snapshot.pid).StartTime!=snapshot.launched ||
            focused==null || focused.Current.IsPassword || !InWindow(focused,snapshot.root)) throw new InvalidOperationException();
        int[] modifiers={16,17,18,91,92}; if(modifiers.Any(key=>(GetAsyncKeyState(key)&0x8000)!=0)) throw new InvalidOperationException();
    }
    Point RawPoint(object raw, Dictionary<string,object> screenshot, Snapshot snapshot) {
        var at=(Dictionary<string,object>)raw; double x=Convert.ToDouble(at["x"]),y=Convert.ToDouble(at["y"]),width=Convert.ToDouble(screenshot["width"]),height=Convert.ToDouble(screenshot["height"]);
        if(Double.IsNaN(x) || Double.IsInfinity(x) || Double.IsNaN(y) || Double.IsInfinity(y) || x<0 || y<0 || x>=width || y>=height) throw new InvalidOperationException();
        var point=new Point {x=snapshot.bounds.left+(int)Math.Floor(x*(snapshot.bounds.right-snapshot.bounds.left)/width),y=snapshot.bounds.top+(int)Math.Floor(y*(snapshot.bounds.bottom-snapshot.bounds.top)/height)};
        CheckPoint(point,snapshot); return point;
    }
    void CheckPoint(Point point, Snapshot snapshot) {
        var hit=AutomationElement.FromPoint(new System.Windows.Point(point.x,point.y));
        if(hit==null || hit.Current.IsPassword || !InWindow(hit,snapshot.root)) throw new InvalidOperationException();
    }
    async Task RawInput(Dictionary<string,object> value,Dictionary<string,object> screenshot,Snapshot snapshot,string token) {
        RawCheck(snapshot,token);
        if(!ObserverReady() || new[]{1,2,4,5,6}.Any(key=>(GetAsyncKeyState(key)&0x8000)!=0)) throw new InvalidOperationException();
        nativeBusy=true; bool failed=false;
        try {
            string kind=(string)value["kind"];
            if(kind=="key") {
                var keys=new Dictionary<string,ushort>{{"ArrowLeft",37},{"ArrowRight",39},{"ArrowUp",38},{"ArrowDown",40},{"Tab",9},{"Space",32},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34}};
                ushort key; if(!keys.TryGetValue((string)value["keys"],out key)) throw new InvalidOperationException();
                heldKey=key; await Post(KeyEvent(key,false),0x100,false); RawCheck(snapshot,token);
                await Post(KeyEvent(key,true),0x101,true); heldKey=null;
            } else if(kind=="drag") {
                Point from=RawPoint(value["from"],screenshot,snapshot),to=RawPoint(value["to"],screenshot,snapshot);
                // Position first; mouse move acknowledgment cannot be mistaken for button acknowledgment.
                await Post(MouseEvent(0,from,0,true),0x200,false); RawCheck(snapshot,token);
                heldButton=true; await Post(MouseEvent(2,from,0,false),0x201,false);
                for(int i=1;i<=8;i++) {
                    RawCheck(snapshot,token); var at=new Point {x=from.x+(to.x-from.x)*i/8,y=from.y+(to.y-from.y)*i/8}; CheckPoint(at,snapshot);
                    await Post(MouseEvent(0,at,0,true),0x200,false); await Task.Delay(20);
                }
                RawCheck(snapshot,token); await Post(MouseEvent(4,to,0,false),0x202,true); heldButton=false;
            } else if(kind=="scroll") {
                int amount=Convert.ToInt32(value["amount"]); if(amount<1 || amount>10 || !value.ContainsKey("at")) throw new InvalidOperationException();
                Point at=RawPoint(value["at"],screenshot,snapshot); string direction=(string)value["direction"];
                await Post(MouseEvent(0,at,0,true),0x200,false); RawCheck(snapshot,token);
                bool horizontal=direction=="left" || direction=="right";
                if(!horizontal && direction!="up" && direction!="down") throw new InvalidOperationException();
                int delta=(direction=="left" || direction=="down"?-1:1)*amount*120;
                await Post(MouseEvent(horizontal?0x1000u:0x800u,at,unchecked((uint)delta),false),horizontal?0x20e:0x20a,false);
            } else throw new InvalidOperationException();
            RawCheck(snapshot,token);
        } catch { Fence(); failed=true; }
        if(failed) await CleanupInput();
        nativeBusy=false;
        if(failed) throw new InvalidOperationException();
    }
    static uint Activity() { var value=new LastInput {size=(uint)Marshal.SizeOf(typeof(LastInput))}; if(!GetLastInputInfo(ref value)) throw new InvalidOperationException(); return value.tick; }
    static bool ConsoleSession() {
        if(Process.GetCurrentProcess().SessionId != WTSGetActiveConsoleSessionId()) return false;
        IntPtr desktop=OpenInputDesktop(0,false,1);
        if(desktop==IntPtr.Zero) return false;
        try { uint needed; var name=new StringBuilder(256); return GetUserObjectInformation(desktop,2,name,512,out needed) && name.ToString()=="Default"; }
        finally { CloseDesktop(desktop); }
    }
    bool Valid(string token, bool needsInput) {
        bool valid = token==session && session!="" && consent && Visible && ConsoleSession() &&
          (Stopwatch.GetTimestamp()-heartbeat)/(double)Stopwatch.Frequency < 2 && ObserverReady() && foreign==baseline && (!needsInput || input);
        if(!valid) Fence(); return valid;
    }
    static Process App(int pid) {
        var process = Process.GetProcessById(pid);
        var name=process.ProcessName.ToLowerInvariant();
        string[] denied={"cmd","powershell","pwsh","windowsterminal","conhost","explorer","taskmgr","mmc","regedit","control","systemsettings","credentialuibroker","consent","logonui","winlogon","mstsc","code","codex","herdr","devenv"};
        if(denied.Contains(name) || process.SessionId != Process.GetCurrentProcess().SessionId || process.MainModule == null || String.IsNullOrWhiteSpace(process.MainModule.FileName)) throw new InvalidOperationException();
        return process;
    }
    static IntPtr Target(Dictionary<string,object> target, out Process process, out Rect bounds) {
        int pid=Int32.Parse((string)target["appId"]); process=App(pid);
        IntPtr handle=new IntPtr(Int64.Parse((string)target["windowId"])); uint actual;
        GetWindowThreadProcessId(handle,out actual);
        if(actual != pid || !IsWindowVisible(handle) || !GetWindowRect(handle,out bounds) || bounds.right<=bounds.left || bounds.bottom<=bounds.top) throw new InvalidOperationException();
        return handle;
    }
    object[] InventoryWindows() {
        var rows = new List<object>();
        EnumWindows((window,param)=> {
            try {
                uint pid; GetWindowThreadProcessId(window,out pid); var app=App((int)pid);
                if(IsWindowVisible(window) && app.Id != Process.GetCurrentProcess().Id) {
                    var title=new StringBuilder(513); GetWindowText(window,title,513);
                    rows.Add(Obj("appId",pid.ToString(),"windowId",window.ToInt64().ToString(),"title",title.ToString()));
                }
            } catch { }
            return true;
        }, IntPtr.Zero);
        return rows.Take(128).ToArray();
    }
    Dictionary<string,object> Observe(Snapshot snapshot, out object[] publicElements) {
        var rows=new List<object>(); var elements=new List<object>();
        snapshot.elements.Clear(); snapshot.labels.Clear();
        var walker=TreeWalker.ControlViewWalker;
        Action<AutomationElement,int> visit=null;
        visit=(element,depth)=> {
            if(rows.Count>=160 || depth>12) return;
            var current=element.Current;
            string value=""; object pattern;
            if(!current.IsPassword && element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) value=((ValuePattern)pattern).Current.Value;
            string name=current.Name ?? ""; if(name.Length>128) name=name.Substring(0,128); if(value.Length>2048) value=value.Substring(0,2048);
            rows.Add(Obj("role",current.ControlType.ProgrammaticName,"label",name,"value",current.IsPassword?"[secure]":value));
            if(!current.IsPassword && current.IsEnabled && element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) {
                string id=Guid.NewGuid().ToString(); snapshot.elements.Add(id,element); snapshot.labels.Add(id,name);
                elements.Add(Obj("id",id,"label",name,"actionable",true));
            }
            int children=0;
            for(var child=walker.GetFirstChild(element);child!=null && children++<160;child=walker.GetNextSibling(child)) visit(child,depth+1);
        };
        visit(snapshot.root,0);
        string tree=json.Serialize(rows); if(tree.Length>8192) tree=tree.Substring(0,8192);
        var access=Obj("tree",tree);
        var focused=AutomationElement.FocusedElement;
        if(focused!=null && !focused.Current.IsPassword && InWindow(focused,snapshot.root)) {
            access["focused_element"]=focused.Current.ControlType.ProgrammaticName+":"+focused.Current.Name;
            object pattern;
            if(focused.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
                string value=((ValuePattern)pattern).Current.Value; access["document_text"]=value.Length>8192?value.Substring(0,8192):value;
            }
        }
        publicElements=elements.ToArray(); return access;
    }
    static bool InWindow(AutomationElement element, AutomationElement root) {
        for(int depth=0;element!=null && depth<32;depth++,element=TreeWalker.ControlViewWalker.GetParent(element))
            if(Automation.Compare(element,root)) return true;
        return false;
    }
    async void HandleRequest(string line) {
        string id="", action=""; bool ownsBusy=false;
        try {
            var message=json.Deserialize<Dictionary<string,object>>(line);
            id=(string)message["id"]; Guid.Parse(id); action=(string)message["action"];
            string token=(string)message["session"]; var value=(Dictionary<string,object>)message["value"];
            if(action=="heartbeat") { heartbeat=Stopwatch.GetTimestamp(); Reply(id,true,Obj()); return; }
            if(action=="stop") { if(token!=session || lease=="") throw new InvalidOperationException(); Fence(); Reply(id,true,StopProof()); return; }
            if(action=="end") { if(injected || busy || nativeBusy || pending.Count!=0 || heldKey.HasValue || heldButton || token!=session) throw new InvalidOperationException(); Fence(); lease=""; session=""; Reply(id,true,Obj()); return; }
            if(busy) throw new InvalidOperationException();
            busy=true; ownsBusy=true;
            if(action=="consent") {
                if(consent || lease!="" || !ConsoleSession()) throw new InvalidOperationException();
                string conversation=(string)value["conversationId"];
                var choice=Consent(conversation);
                consent=choice!=DialogResult.Cancel && InstallObserver(); input=consent && choice==DialogResult.No;
                if(consent) { session=token; injected=false; heartbeat=Stopwatch.GetTimestamp(); baseline=foreign; lastPerson=Stopwatch.GetTimestamp(); label.Text=input?"🐾 Clankie is driving":"🐾 Clankie is observing · input off"; Show(); }
                Reply(id,true,Obj("approved",consent,"allowInput",input)); return;
            }
            if(!Valid(token,false)) throw new InvalidOperationException();
            if(action=="bind") { if(lease!="") throw new InvalidOperationException(); lease=(string)value["leaseId"]; Reply(id,true,Obj("bound",true)); return; }
            if(lease=="") throw new InvalidOperationException();
            if(action=="inventory") {
                var windows=InventoryWindows(); var apps=windows.Cast<Dictionary<string,object>>().GroupBy(row=>(string)row["appId"]).Select(group=>Obj("appId",group.Key,"name",App(Int32.Parse(group.Key)).ProcessName)).ToArray();
                Reply(id,true,Obj("complete",false,"apps",apps,"windows",windows)); return;
            }
            if(action=="capture") {
                var target=(Dictionary<string,object>)value["target"]; Process app; Rect bounds; IntPtr window=Target(target,out app,out bounds);
                if(window!=GetForegroundWindow()) throw new InvalidOperationException(); // Screen copy cannot prove unoccluded background pixels.
                int width=bounds.right-bounds.left, height=bounds.bottom-bounds.top;
                if(width>4096 || height>4096) throw new InvalidOperationException();
                var snapshot=new Snapshot {window=window,pid=app.Id,launched=app.StartTime,bounds=bounds,captured=Stopwatch.GetTimestamp(),root=AutomationElement.FromHandle(window)};
                byte[] png;
                using(var bitmap=new Bitmap(width,height)) { using(var graphics=Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.left,bounds.top,0,0,new Size(width,height)); using(var stream=new MemoryStream()) {bitmap.Save(stream,ImageFormat.Png); png=stream.ToArray();} }
                object[] elements; var access=Observe(snapshot,out elements);
                if(!Valid(token,false) || GetForegroundWindow()!=window) throw new InvalidOperationException();
                Rect after; if(!GetWindowRect(window,out after) || !Same(bounds,after) || png.Length>16*1024*1024) throw new InvalidOperationException();
                string reference=Guid.NewGuid().ToString(); snapshots.Clear(); snapshots.Add(reference,snapshot);
                Reply(id,true,Obj("png",Convert.ToBase64String(png),"reference",reference,"elements",elements,"accessibility",access,"coordinates",Obj("space","global_display_points","origin","top_left","bounds",Obj("x",bounds.left,"y",bounds.top,"width",width,"height",height)))); return;
            }
            if(action=="input") {
                if(!Valid(token,true) || (Stopwatch.GetTimestamp()-lastPerson)/(double)Stopwatch.Frequency<2) throw new InvalidOperationException();
                var snapshot=snapshots[(string)value["reference"]]; var inputValue=(Dictionary<string,object>)value["input"];
                var screenshot=(Dictionary<string,object>)value["screenshot"]; var expect=(Dictionary<string,object>)inputValue["expect"];
                if((Stopwatch.GetTimestamp()-snapshot.captured)/(double)Stopwatch.Frequency >= 30 || !(bool)inputValue["foreground"] || (string)screenshot["leaseId"]!=lease || App(snapshot.pid).StartTime!=snapshot.launched) throw new InvalidOperationException();
                Rect bounds; uint pid; GetWindowThreadProcessId(snapshot.window,out pid);
                if(pid!=snapshot.pid || !GetWindowRect(snapshot.window,out bounds) || !Same(bounds,snapshot.bounds)) throw new InvalidOperationException();
                string field=(string)expect["field"], equals=(string)expect["equals"]; object[] ignored;
                // Preserve the exact captured element IDs while refreshing the observation.
                var capturedElements=new Dictionary<string,AutomationElement>(snapshot.elements);
                var capturedLabels=new Dictionary<string,string>(snapshot.labels);
                var before=Observe(snapshot,out ignored); object original;
                if(before.TryGetValue(field,out original) && (string)original==equals) throw new InvalidOperationException();
                if(GetForegroundWindow()!=snapshot.window && !SetForegroundWindow(snapshot.window)) throw new InvalidOperationException();
                if(GetForegroundWindow()!=snapshot.window || !Valid(token,true)) throw new InvalidOperationException();
                string kind=(string)inputValue["kind"];
                if(kind=="key" || kind=="drag" || kind=="scroll") {
                    await RawInput(inputValue,screenshot,snapshot,token);
                } else if(kind=="type") {
                    string append=(string)inputValue["text"]; if((bool)inputValue["clear"] || append.Length>2048 || append.Any(Char.IsControl)) throw new InvalidOperationException();
                    var focused=AutomationElement.FocusedElement; object pattern;
                    if(focused==null || focused.Current.IsPassword || !InWindow(focused,snapshot.root) || !focused.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) throw new InvalidOperationException();
                    var native=(ValuePattern)pattern; if(native.Current.IsReadOnly) throw new InvalidOperationException();
                    injected=true; native.SetValue(native.Current.Value+append);
                } else {
                    AutomationElement element=null;
                    if(kind=="element") capturedElements.TryGetValue((string)inputValue["elementId"],out element);
                    if(kind=="click" && (string)inputValue["button"]=="left") {
                        var at=(Dictionary<string,object>)inputValue["at"]; double x=Convert.ToDouble(at["x"]), y=Convert.ToDouble(at["y"]), width=Convert.ToDouble(screenshot["width"]), height=Convert.ToDouble(screenshot["height"]);
                        if(x<0 || y<0 || x>=width || y>=height) throw new InvalidOperationException();
                        var hit=AutomationElement.FromPoint(new System.Windows.Point(bounds.left+x*(bounds.right-bounds.left)/width,bounds.top+y*(bounds.bottom-bounds.top)/height));
                        element=capturedElements.Values.FirstOrDefault(e=>Automation.Compare(e,hit));
                    }
                    object pattern;
                    if(element==null || element.Current.IsPassword || !InWindow(element,snapshot.root) || !capturedElements.Any(pair=>Automation.Compare(pair.Value,element) && capturedLabels[pair.Key]==(element.Current.Name.Length>128?element.Current.Name.Substring(0,128):element.Current.Name)) || !element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) throw new InvalidOperationException();
                    injected=true; ((InvokePattern)pattern).Invoke();
                }
                snapshots.Clear(); var after=Observe(snapshot,out ignored); object actual;
                bool changed=Valid(token,true) && GetForegroundWindow()==snapshot.window && after.TryGetValue(field,out actual) && (string)actual==equals;
                if(!changed) Fence();
                Reply(id,true,Obj("outcome",changed?"confirmed":"uncertain","detail",changed?"Exact changed accessibility field observed":"Native effect uncertain; stop and retain lease")); return;
            }
            throw new InvalidOperationException();
        } catch { if(action=="input") Fence(); if(id!="") Reply(id,false,Obj()); }
        finally { if(ownsBusy) busy=false; }
    }
    static bool Same(Rect a,Rect b) { return a.left==b.left && a.top==b.top && a.right==b.right && a.bottom==b.bottom; }
    protected override bool ShowWithoutActivation { get { return true; } }
    DialogResult Consent(string conversation) {
        using(var prompt=new Form {Text="Lend this screen to Clankie?",Width=520,Height=230,FormBorderStyle=FormBorderStyle.FixedDialog,StartPosition=FormStartPosition.CenterScreen,TopMost=true}) {
            prompt.Controls.Add(new Label {Left=12,Top=12,Width=480,Height=115,Text="Session: "+conversation+"\nObserve is read-only. Allow input lets Clankie press accessible controls, append text, use navigation keys, drag and scroll. Your input or Stop ends consent. Sign-ins, codes, payments and destructive actions stay with you."});
            var observe=new Button {Left=12,Top=130,Width=140,Text="Observe only",DialogResult=DialogResult.Yes};
            var cancel=new Button {Left=162,Top=130,Width=100,Text="Cancel",DialogResult=DialogResult.Cancel};
            var drive=new Button {Left=272,Top=130,Width=140,Text="Allow input",DialogResult=DialogResult.No};
            prompt.Controls.Add(observe);prompt.Controls.Add(cancel);prompt.Controls.Add(drive);prompt.AcceptButton=observe;prompt.CancelButton=cancel;
            return prompt.ShowDialog();
        }
    }
    public ClankieLentScreen() {
        Text="Clankie"; Width=420; Height=130; TopMost=true; FormBorderStyle=FormBorderStyle.FixedToolWindow;
        Controls.Add(label); var stop=new Button {Left=12,Top=58,Width=100,Text="Stop"}; stop.Click+=(s,e)=>Fence(); Controls.Add(stop);
        FormClosing+=(s,e)=>{Fence(); e.Cancel=true;};
        timer.Tick+=(s,e)=>{ if(consent) {try {Valid(session,false);}catch {Fence();}} }; timer.Start();
        var reader=new Thread(()=> {
            string line; while((line=Console.ReadLine())!=null) { if(line.Length>65536) continue; string captured=line; BeginInvoke(new Action(()=>HandleRequest(captured))); }
            BeginInvoke(new Action(()=>{Fence(); Environment.Exit(0);}));
        }); reader.IsBackground=true; bool readerStarted=false; Shown+=(s,e)=>{ if(!readerStarted) { readerStarted=true; Hide(); reader.Start(); } };
    }
    [STAThread] public static void Run() { Console.OutputEncoding=new UTF8Encoding(false); Console.InputEncoding=new UTF8Encoding(false); SetProcessDpiAwarenessContext(new IntPtr(-4)); if(!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4))) throw new InvalidOperationException(); Application.EnableVisualStyles(); Application.Run(new ClankieLentScreen()); }
}
