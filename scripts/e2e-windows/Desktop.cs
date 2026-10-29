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
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
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
 public Game(string folder) {
  dir=folder; Directory.CreateDirectory(dir); log=new StreamWriter(Path.Combine(dir,"input.jsonl"),true){AutoFlush=true};
  Text="Kimochi E2E Fake Game (GDI)"; ClientSize=new Size(1001,701); Location=new Point(130,90); StartPosition=FormStartPosition.Manual; DoubleBuffered=true; BackColor=Color.FromArgb(20,28,40); KeyPreview=true;
  var timer=new System.Windows.Forms.Timer{Interval=16}; timer.Tick+=(s,e)=>Tick(); timer.Start();
  FormClosed+=(s,e)=>{log.Dispose();log=null;}; Move+=(s,e)=>Invalidate(); Resize+=(s,e)=>Invalidate();
 }
 void Write(object o){if(log!=null)log.WriteLine(json.Serialize(o));}
 protected override void WndProc(ref Message m) {
  if((m.Msg>=0x100&&m.Msg<=0x109)||(m.Msg>=0x200&&m.Msg<=0x20e)||m.Msg==6||m.Msg==7||m.Msg==8) Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="message",msg=m.Msg,wparam=m.WParam.ToInt64(),lparam=m.LParam.ToInt64(),foreground=Native.GetForegroundWindow().ToInt64()});
  if(m.Msg==0x100 && (m.WParam.ToInt32()==32||m.WParam.ToInt32()==13)) {page++;Invalidate();}
  base.WndProc(ref m);
 }
 void Tick() {
  for(int k=1;k<256;k++){bool down=Native.GetAsyncKeyState(k)<0;if(keys[k]!=down){keys[k]=down;Write(new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),kind="async",key=k,down,focused=Native.GetForegroundWindow()==Handle});}}
  if(++ticks%6!=0)return;
  string file=Path.Combine(dir,"command.txt"); if(!File.Exists(file))return; string cmd; try{cmd=File.ReadAllText(file).Trim();File.Delete(file);}catch(IOException){return;}
  Write(new{kind="command",command=cmd,time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
  if(cmd=="advance"){page++;Invalidate();} else if(cmd=="close")Close(); else if(cmd=="minimize")WindowState=FormWindowState.Minimized;
  else if(cmd=="restore"){WindowState=FormWindowState.Normal;Native.SetForegroundWindow(Handle);Invalidate();}
  else if(cmd=="borderless"){saved=Bounds;FormBorderStyle=FormBorderStyle.None;Bounds=Screen.FromHandle(Handle).Bounds;mode=cmd;Invalidate();}
  else if(cmd=="windowed"){FormBorderStyle=FormBorderStyle.Sizable;Bounds=saved.Width>0?saved:new Rectangle(130,90,1017,740);mode=cmd;Invalidate();}
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
  Action<string,int,int,int,bool> line=(text,x,y,size,vertical)=>{
   var glyphs=new List<object>(); using(var font=new Font("Yu Gothic",size,FontStyle.Regular,GraphicsUnit.Pixel)){
    for(int i=0;i<text.Length;i++){int gx=x+(vertical?0:i*size),gy=y+(vertical?i*size:0);e.Graphics.DrawString(text[i].ToString(),font,Brushes.White,gx,gy,StringFormat.GenericTypographic); glyphs.Add(new{c=text[i].ToString(),x=gx+origin.X,y=gy+origin.Y,w=size,h=size});}
   }
   int width=vertical?size:text.Length*size,height=vertical?text.Length*size:size;
   lines.Add(new{text,size,vertical,x=x+origin.X,y=y+origin.Y,width,height,glyphs});
   words.Add(new{text,x=x+origin.X,y=y+origin.Y,width,height});
  };
  line("回想",65,55,38,false);line("音楽",65,125,38,false);line("想",65,195,38,false);line("回",135,195,38,false);
  line("日本語の本を読む",ClientSize.Width-90,45,28,true);
  line("にほんご",50,ClientSize.Height-190,14,false);
  line(page%2==0?"今日は猫と一緒に学校へ行きます。":"明日は友達と日本語の本を読みます。",50,ClientSize.Height-165,28,false);
  line("青い空と静かな海が好きです。",50,ClientSize.Height-105,28,false);
  targetGraphics.DrawImageUnscaled(bitmap,0,0);
  var truth=new{time=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),page,mode,renderer="GDI",hwnd=Handle.ToInt64(),dpi=Native.GetDpiForWindow(Handle),client=new{x=origin.X,y=origin.Y,width=ClientSize.Width,height=ClientSize.Height},lines,words};
  string path=Path.Combine(dir,"truth.json"); File.WriteAllText(path+".tmp",json.Serialize(truth)); if(File.Exists(path))File.Delete(path);File.Move(path+".tmp",path);
  }
 }
}

public class Program {
 [STAThread] public static void Main(string[] args){
  Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
  if(args.Length==0)throw new Exception("game <directory> | windows | key <vk> <down|up> | chord <vk...> | mouse <x> <y> [click|down|up] | focus <hwnd> | show <hwnd> <n> | move <hwnd> <x> <y> <w> <h> | screenshot <path>");
  if(args[0]=="game"){Application.EnableVisualStyles();Application.Run(new Game(args[1]));}
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
