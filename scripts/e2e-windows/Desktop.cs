using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Threading;

public static class Native {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool on);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 public static bool Focus(IntPtr h){uint pid;uint fg=GetWindowThreadProcessId(GetForegroundWindow(),out pid),target=GetWindowThreadProcessId(h,out pid),self=GetCurrentThreadId();if(fg!=self)AttachThreadInput(self,fg,true);if(target!=self&&target!=fg)AttachThreadInput(self,target,true);try{BringWindowToTop(h);return SetForegroundWindow(h);}finally{if(target!=self&&target!=fg)AttachThreadInput(self,target,false);if(fg!=self)AttachThreadInput(self,fg,false);}}
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool redraw);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int size; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public RECT caretRect; }
 [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GUITHREADINFO info);
 /// The foreground thread's GUI state: flags 0x4 is GUI_INMENUMODE (a window's menu loop is running).
 public static object GuiInfo(){uint pid;var fg=GetForegroundWindow();var info=new GUITHREADINFO{size=Marshal.SizeOf(typeof(GUITHREADINFO))};GetGUIThreadInfo(GetWindowThreadProcessId(fg,out pid),ref info);return new{foreground=fg.ToInt64(),pid,flags=info.flags,menuOwner=info.menuOwner.ToInt64(),capture=info.capture.ToInt64(),focus=info.focus.ToInt64()};}
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 // Magpie (a window scaler) publishes its session on its scaling window, as its docs describe: the scaled
 // window, the scaled part of it (Src) and where the picture is drawn (Dest), in physical pixels. While the
 // game has the mouse the scaling window is WS_EX_TRANSPARENT and the cursor is over the game itself.
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls,string title);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetPropW(IntPtr h,string name);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [StructLayout(LayoutKind.Sequential)] public struct POINT{public int x,y;}
 public static object Magpie(){var h=FindWindowW("Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22",null);if(h==IntPtr.Zero||!IsWindowVisible(h))return null;Func<string,int>p=n=>(int)GetPropW(h,"Magpie."+n).ToInt64();int ex=GetWindowLong(h,-20);RECT r;GetWindowRect(h,out r);POINT c;GetCursorPos(out c);return new{hwnd=h.ToInt64(),source=GetPropW(h,"Magpie.SrcHWND").ToInt64(),windowed=p("Windowed")!=0,src=new{left=p("SrcLeft"),top=p("SrcTop"),right=p("SrcRight"),bottom=p("SrcBottom")},dest=new{left=p("DestLeft"),top=p("DestTop"),right=p("DestRight"),bottom=p("DestBottom")},surface=new{left=r.left,top=r.top,right=r.right,bottom=r.bottom},captured=(ex&0x20)!=0,topmost=(ex&0x8)!=0,cursor=new{x=c.x,y=c.y}};}
 // GDI text calls, so a text hooker's generic API hooks see the game's text (the "hookable" game).
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontW(int h,int w,int esc,int orient,int weight,uint italic,uint underline,uint strike,uint charset,uint outPrecision,uint clipPrecision,uint quality,uint pitch,string face);
 [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc,IntPtr o);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
 [DllImport("gdi32.dll")] public static extern int SetBkMode(IntPtr dc,int mode);
 [DllImport("gdi32.dll")] public static extern uint SetTextColor(IntPtr dc,int color);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] public static extern bool TextOutW(IntPtr dc,int x,int y,string text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int DrawTextW(IntPtr dc,string text,int count,ref RECT rect,uint format);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int DrawTextExW(IntPtr dc,string text,int count,ref RECT rect,uint format,IntPtr parameters);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] inputs,int size);
 public static void Key(int key,bool up) { var a=new INPUT[]{new INPUT{type=1,u=new UNION{key=new KEY{vk=(ushort)key,flags=(up?2u:0u) | (key==45?1u:0u)}}}}; if(SendInput(1,a,Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput: "+Marshal.GetLastWin32Error()); }
 public static void Mouse(uint flags) { var a=new INPUT[]{new INPUT{type=0,u=new UNION{mouse=new MOUSE{flags=flags}}}}; if(SendInput(1,a,Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("SendInput mouse failed"); }
 public static object Windows() { var list=new List<object>(); int z=0; EnumWindows((h,p)=>{var s=new System.Text.StringBuilder(1024); GetWindowText(h,s,1024); uint pid,a; RECT r; GetWindowThreadProcessId(h,out pid); GetWindowRect(h,out r); GetWindowDisplayAffinity(h,out a); list.Add(new {hwnd=h.ToInt64(),pid,title=s.ToString(),visible=IsWindowVisible(h),iconic=IsIconic(h),foreground=h==GetForegroundWindow(),affinity=a,z=z++,rect=new {x=r.left,y=r.top,width=r.right-r.left,height=r.bottom-r.top}}); return true;},IntPtr.Zero); return list; }
}

public class Game : Form {
 string dir; int page; int ticks; bool[] keys=new bool[256]; string mode="windowed"; Rectangle saved; StreamWriter log; JavaScriptSerializer json=new JavaScriptSerializer();
 // Like a visual novel: Ctrl held skips a page every 100 ms. "focused" polls only while this window
 // is the foreground one; "active" polls while WM_ACTIVATEAPP last said the app is active, as many
 // engines do (a game told it is active and never told otherwise keeps reading the keyboard, #27).
 string skip="off"; bool appActive; bool minimizeOnBlur; int advances;
 // "say <text>": the dialogue's first line until the next advance, so a test can show a line the
 // Log has not seen before (the Log drops a line that repeats a recent one).
 string said;
 // "type <a>|<b>": a game typing its text out, read by clicking twice quickly: the first few
 // frames of <a>, then all of <a> at once (the first click), then <b> typed out a character at a
 // time (the second click), a frame every 30 ms, so a text hooker gets every frame in one burst.
 // The dialogue is the one line, alone, until the next advance or say.
 // "typeout <text>": <text> typed out a character a frame; at each "‖" in it the typing holds for
 // a second, longer than a text hooker waits, as a game pauses on a drawn-out "ーーー".
 Queue<string> typing=new Queue<string>(); bool alone; System.Windows.Forms.Timer typer; const string Hold="\u0000";
 // "hookable": the dialogue is drawn with TextOutW, a speaker nameplate with DrawTextW and a HUD
 // string with DrawTextExW (LunaHook's generic API hooks cover all three, not ExtTextOutW), so a text hooker finds several threads and must pick the dialogue one.
 public bool hookable;
 public const string Speaker="ミサキ", Hud="オート　スキップ　セーブ";
 void Advance(string reason){page++;advances++;Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="advance",reason,page,foreground=Native.GetForegroundWindow()==Handle});Invalidate();}
 public Game(string folder,string title=null) {
  dir=folder; Directory.CreateDirectory(dir); log=new StreamWriter(Path.Combine(dir,"input.jsonl"),true){AutoFlush=true};
  Text=title??"Kimochi E2E Fake Game (GDI)"; ClientSize=new Size(1001,701); Location=new Point(130,90); StartPosition=FormStartPosition.Manual; DoubleBuffered=true; BackColor=Color.FromArgb(20,28,40); KeyPreview=true;
  var timer=new System.Windows.Forms.Timer{Interval=16}; timer.Tick+=(s,e)=>Tick(); timer.Start();
  FormClosed+=(s,e)=>{log.Dispose();log=null;}; Move+=(s,e)=>Invalidate(); Resize+=(s,e)=>Invalidate();
 }
 void Write(object o){if(log!=null)log.WriteLine(json.Serialize(o));}
 void StartTyping(){
  if(typer==null){typer=new System.Windows.Forms.Timer{Interval=30};typer.Tick+=(s,e)=>{if(typing.Count==0){typer.Stop();return;}string next=typing.Dequeue();if(next==Hold)return;said=next;Invalidate();Update();};}
  typer.Start();
 }
 protected override void WndProc(ref Message m) {
  if((m.Msg>=0x100&&m.Msg<=0x109)||(m.Msg>=0x200&&m.Msg<=0x20e)||m.Msg==6||m.Msg==7||m.Msg==8||m.Msg==0x1C||m.Msg==0x86) Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="message",msg=m.Msg,wparam=m.WParam.ToInt64(),lparam=m.LParam.ToInt64(),foreground=Native.GetForegroundWindow().ToInt64()});
  if(m.Msg==0x100 && (m.WParam.ToInt32()==32||m.WParam.ToInt32()==13)) Advance("key");
  if(m.Msg==0x1C){appActive=m.WParam!=IntPtr.Zero; if(!appActive&&minimizeOnBlur) BeginInvoke((Action)(()=>WindowState=FormWindowState.Minimized));}
  base.WndProc(ref m);
 }
 void Tick() {
  for(int k=1;k<256;k++){bool down=Native.GetAsyncKeyState(k)<0;if(keys[k]!=down){keys[k]=down;Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="async",key=k,down,focused=Native.GetForegroundWindow()==Handle});}}
  if(++ticks%6!=0)return;
  if(keys[17]&&(skip=="active"&&appActive||skip=="focused"&&Native.GetForegroundWindow()==Handle)) Advance(Native.GetForegroundWindow()==Handle?"ctrl-skip":"ctrl-skip-unfocused");
  string file=Path.Combine(dir,"command.txt"); if(!File.Exists(file))return; string cmd; try{cmd=File.ReadAllText(file).Trim();File.Delete(file);}catch(IOException){return;}
  Write(new{kind="command",command=cmd,time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
  if(cmd=="advance"){said=null;alone=false;Advance("command");}
  else if(cmd.StartsWith("say ")){said=cmd.Substring(4);alone=false;Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="say",text=said});Invalidate();}
  else if(cmd.StartsWith("type ")){
   var parts=cmd.Substring(5).Split('|'); typing.Clear();
   string a=parts[0]; for(int n=1;n<=Math.Min(4,a.Length);n++)typing.Enqueue(a.Substring(0,n)); typing.Enqueue(a);
   if(parts.Length>1){string b=parts[1];for(int n=1;n<=b.Length;n++)typing.Enqueue(b.Substring(0,n));}
   alone=true; Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="type",lines=parts});
   StartTyping();
  }
  else if(cmd.StartsWith("typeout ")){
   string text=cmd.Substring(8); typing.Clear(); string shown="";
   foreach(char c in text){if(c=='‖'){for(int i=0;i<34;i++)typing.Enqueue(Hold);continue;} shown+=c; typing.Enqueue(shown);}
   alone=true; Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="typeout",text});
   StartTyping();
  }
  else if(cmd.StartsWith("skip "))skip=cmd.Substring(5);
  else if(cmd=="minimize-on-blur on"||cmd=="minimize-on-blur off")minimizeOnBlur=cmd.EndsWith("on"); else if(cmd=="close")Close(); else if(cmd=="minimize")WindowState=FormWindowState.Minimized;
  else if(cmd=="restore"){WindowState=FormWindowState.Normal;Native.SetForegroundWindow(Handle);Invalidate();}
  else if(cmd=="borderless"){saved=Bounds;FormBorderStyle=FormBorderStyle.None;Bounds=Screen.FromHandle(Handle).Bounds;mode=cmd;Invalidate();}
  else if(cmd=="windowed"){FormBorderStyle=FormBorderStyle.Sizable;Bounds=saved.Width>0?saved:new Rectangle(130,90,1017,740);mode=cmd;Invalidate();}
  // "center": the window in the middle of its screen (Magpie scales a window in place, centred on it).
  else if(cmd=="center"){var sc=Screen.FromHandle(Handle).Bounds;Location=new Point(sc.X+(sc.Width-Width)/2,sc.Y+(sc.Height-Height)/2);Invalidate();}
  else if(cmd.StartsWith("move ")){var a=cmd.Split(' ');Bounds=new Rectangle(int.Parse(a[1]),int.Parse(a[2]),int.Parse(a[3]),int.Parse(a[4]));Invalidate();}
 }
 protected override void OnPaintBackground(PaintEventArgs e){base.OnPaintBackground(e);}
 protected override void OnPaint(PaintEventArgs e) {
  base.OnPaint(e); if(ClientSize.Width<=0||ClientSize.Height<=0)return;
  var targetGraphics=e.Graphics;
  using(var bitmap=new Bitmap(ClientSize.Width,ClientSize.Height,System.Drawing.Imaging.PixelFormat.Format32bppArgb)) using(var graphics=Graphics.FromImage(bitmap)) {
  e=new PaintEventArgs(graphics,ClientRectangle); e.Graphics.Clear(BackColor);
  var origin=PointToScreen(Point.Empty); var lines=new List<object>(); var words=new List<object>();
  e.Graphics.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
  using(var box=new SolidBrush(Color.FromArgb(35,45,65))) e.Graphics.FillRectangle(box,25,ClientSize.Height-215,Math.Max(100,ClientSize.Width-50),180);
  bool recordOnly=false;
  Action<string,int,int,int,bool> line=(text,x,y,size,vertical)=>{
   var glyphs=new List<object>(); using(var font=new Font("Yu Gothic",size,FontStyle.Regular,GraphicsUnit.Pixel)){
    for(int i=0;i<text.Length;i++){int gx=x+(vertical?0:i*size),gy=y+(vertical?i*size:0);if(!recordOnly)e.Graphics.DrawString(text[i].ToString(),font,Brushes.White,gx,gy,StringFormat.GenericTypographic); glyphs.Add(new{c=text[i].ToString(),x=gx+origin.X,y=gy+origin.Y,w=size,h=size});}
   }
   int width=vertical?size:text.Length*size,height=vertical?text.Length*size:size;
   lines.Add(new{text,size,vertical,x=x+origin.X,y=y+origin.Y,width,height,glyphs});
   foreach(string word in new[]{"回想","音楽","日本語","本","読む","今日","明日","猫","犬","一緒","学校","青い","空","静かな","海","好き","にほんご"}) {
    int at=text.IndexOf(word,StringComparison.Ordinal); if(at<0)continue;
    words.Add(new{text=word,x=x+origin.X+(vertical?0:at*size),y=y+origin.Y+(vertical?at*size:0),width=vertical?size:word.Length*size,height=vertical?word.Length*size:size});
   }
  };
  line("回想",65,55,38,false);line("音楽",65,125,38,false);line("想",65,195,38,false);line("回",135,195,38,false);
  line("日本語の本を読む",ClientSize.Width-90,45,28,true);
  line("にほんご",50,ClientSize.Height-190,14,false);
  string first=said??(page%2==0?"今日は猫と一緒に学校へ行きます。":"明日は友達と日本語の本を読みます。"),second="青い空と静かな海が好きです。";
  var gdi=new List<Tuple<string,int,int,int,string>>();
  if(hookable){
   // Recorded in the truth like the GDI+ lines, then drawn below with GDI once the frame is up.
   Action<string,int,int,int,string> record=(text,x,y,size,api)=>{line(text,x,y,size,false);gdi.Add(Tuple.Create(text,x,y,size,api));};
   recordOnly=true;
   record(Speaker,50,ClientSize.Height-255,24,"DrawTextW"); record(first,50,ClientSize.Height-165,28,"TextOutW"); if(!alone)record(second,50,ClientSize.Height-105,28,"TextOutW"); record(Hud,ClientSize.Width-420,20,18,"DrawTextExW");
   recordOnly=false;
  } else {
  line(first,50,ClientSize.Height-165,28,false);
  line(second,50,ClientSize.Height-105,28,false);
  }
  targetGraphics.DrawImageUnscaled(bitmap,0,0);
  if(gdi.Count>0){
   IntPtr dc=targetGraphics.GetHdc();
   try{
    Native.SetBkMode(dc,1); Native.SetTextColor(dc,0xFFFFFF);
    foreach(var t in gdi){
     IntPtr font=Native.CreateFontW(-t.Item4,0,0,0,400,0,0,0,128,0,0,4,0,"Yu Gothic"); IntPtr old=Native.SelectObject(dc,font);
     var r=new Native.RECT{left=t.Item2,top=t.Item3,right=t.Item2+t.Item1.Length*t.Item4+40,bottom=t.Item3+t.Item4+8};
     if(t.Item5=="TextOutW") Native.TextOutW(dc,t.Item2,t.Item3,t.Item1,t.Item1.Length);
     else if(t.Item5=="DrawTextW") Native.DrawTextW(dc,t.Item1,t.Item1.Length,ref r,0x20);
     else Native.DrawTextExW(dc,t.Item1,t.Item1.Length,ref r,0x20,IntPtr.Zero);
     Native.SelectObject(dc,old); Native.DeleteObject(font);
    }
   } finally { targetGraphics.ReleaseHdc(dc); }
  }
  var truth=new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),pid=System.Diagnostics.Process.GetCurrentProcess().Id,bits=IntPtr.Size*8,hookable,dialogue=hookable?(alone?first:first+second):null,typing=typing.Count>0,speaker=hookable?Speaker:null,hud=hookable?Hud:null,page,advances,skip,believesActive=appActive,minimizeOnBlur,mode,renderer="GDI",hwnd=Handle.ToInt64(),dpi=Native.GetDpiForWindow(Handle),client=new{x=origin.X,y=origin.Y,width=ClientSize.Width,height=ClientSize.Height},lines,words};
  string path=Path.Combine(dir,"truth.json"); File.WriteAllText(path+".tmp",json.Serialize(truth)); if(File.Exists(path))File.Replace(path+".tmp",path,null);else File.Move(path+".tmp",path);
  }
 }
}

public class Program {
 [STAThread] public static void Main(string[] args){
  Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
  if(args.Length==0)throw new Exception("game <directory> [title] [hookable] | windows | magpie | guiinfo | key <vk> <down|up> | chord <vk...> | mouse <x> <y> [click|down|up] | focus <hwnd> | show <hwnd> <n> | move <hwnd> <x> <y> <w> <h> | screenshot <path>");
  if(args[0]=="game"){Application.EnableVisualStyles();Application.Run(new Game(args[1],args.Length>2&&args[2]!=""?args[2]:null){hookable=args.Contains("hookable")});}
  else if(args[0]=="guiinfo") Console.WriteLine(new JavaScriptSerializer().Serialize(Native.GuiInfo()));
  else if(args[0]=="magpie") Console.WriteLine(new JavaScriptSerializer().Serialize(Native.Magpie()));
  else if(args[0]=="windows") Console.WriteLine(new JavaScriptSerializer().Serialize(Native.Windows()));
  else if(args[0]=="key") Native.Key(int.Parse(args[1]),args[2]=="up");
  else if(args[0]=="chord"){var k=args.Skip(1).Select(int.Parse).ToArray();foreach(int v in k){Native.Key(v,false);Thread.Sleep(60);}Thread.Sleep(100);foreach(int v in k.Reverse()){Native.Key(v,true);Thread.Sleep(40);}}
  else if(args[0]=="mouse"){Native.SetCursorPos(int.Parse(args[1]),int.Parse(args[2]));if(args.Length>3){if(args[3]=="click"||args[3]=="down")Native.Mouse(2);if(args[3]=="click")Thread.Sleep(60);if(args[3]=="click"||args[3]=="up")Native.Mouse(4);}}
  else if(args[0]=="focus")Console.WriteLine(Native.Focus(new IntPtr(long.Parse(args[1]))));
  else if(args[0]=="show"){Native.ShowWindow(new IntPtr(long.Parse(args[1])),int.Parse(args[2]));Native.ShowWindow(new IntPtr(long.Parse(args[1])),int.Parse(args[2]));}
  else if(args[0]=="move")Native.MoveWindow(new IntPtr(long.Parse(args[1])),int.Parse(args[2]),int.Parse(args[3]),int.Parse(args[4]),int.Parse(args[5]),true);
  else if(args[0]=="screenshot"){var r=SystemInformation.VirtualScreen;using(var b=new Bitmap(r.Width,r.Height))using(var g=Graphics.FromImage(b)){g.CopyFromScreen(r.Location,Point.Empty,r.Size);b.Save(args[1]);}}
 }
}
