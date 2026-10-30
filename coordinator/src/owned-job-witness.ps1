param([Parameter(Mandatory=$true)][string]$ControlPath, [Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference = 'Stop'
# As in owned-windows-job.ps1: load Add-Type's module from PSHOME instead of searching every module on PSModulePath.
$PSModuleAutoLoadingPreference = 'None'
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ArenaJobWitness {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint length,out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
    [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);
    static List<uint> Members(IntPtr job) {
        int size=65536;
        while(true) {
            IntPtr data=Marshal.AllocHGlobal(size);
            try {
                uint returned;
                if(!QueryInformationJobObject(job,3,data,(uint)size,out returned)) {
                    if(Marshal.GetLastWin32Error()==234){size=checked(size*2);continue;}
                    throw new InvalidOperationException("membership_query_failed");
                }
                var result=new List<uint>(); int count=Marshal.ReadInt32(data,4);
                for(int i=0;i<count;i++) result.Add(checked((uint)Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64()));
                return result;
            }finally{Marshal.FreeHGlobal(data);}
        }
    }
    public static void Observe(string control,string evidence) {
        IntPtr job=IntPtr.Zero,wrapper=IntPtr.Zero;
        var retained=new List<IntPtr>(); var current=new Dictionary<uint,IntPtr>();
        bool frozen=false,allExited=false,wrapperExited=false,jobClosedBeforeStop=false;
        var clock=Stopwatch.StartNew();
        try {
            while(!File.Exists(control)) {
                if(clock.ElapsedMilliseconds>20000)throw new TimeoutException();
                System.Threading.Thread.Sleep(20);
            }
            var values=File.ReadAllText(control).Split(' ');
            job=new IntPtr(long.Parse(values[0]));wrapper=new IntPtr(long.Parse(values[1]));
            File.Delete(control);File.WriteAllText(control+".ready","ready");
            while(!File.Exists(evidence+".freeze")) {
                if(WaitForSingleObject(wrapper,0)==0||clock.ElapsedMilliseconds>300000)throw new TimeoutException();
                System.Threading.Thread.Sleep(20);
            }
            long freezeAt=clock.ElapsedMilliseconds;
            while(true) {
                foreach(uint pid in Members(job)) {
                    IntPtr prior;
                    if(current.TryGetValue(pid,out prior)&&WaitForSingleObject(prior,0)!=0)continue;
                    IntPtr handle=OpenProcess(0x00101800,false,pid);
                    if(handle==IntPtr.Zero) {
                        if(Marshal.GetLastWin32Error()==87)continue;
                        throw new InvalidOperationException("member_open_failed");
                    }
                    bool member;
                    if(!IsProcessInJob(handle,job,out member)){CloseHandle(handle);throw new InvalidOperationException("membership_check_failed");}
                    if(!member){CloseHandle(handle);continue;}
                    // Check and suspension share the retained handle. PID reuse outside the job is harmless.
                    if(NtSuspendProcess(handle)!=0&&WaitForSingleObject(handle,0)!=0){CloseHandle(handle);throw new InvalidOperationException("member_suspend_failed");}
                    retained.Add(handle);current[pid]=handle;
                }
                bool covered=true;
                foreach(uint pid in Members(job)) {
                    IntPtr held;
                    if(!current.TryGetValue(pid,out held)||WaitForSingleObject(held,0)==0){covered=false;break;}
                }
                if(covered)break;
                if(clock.ElapsedMilliseconds-freezeAt>10000)throw new TimeoutException();
            }
            if(retained.Count==0||WaitForSingleObject(wrapper,0)==0)throw new InvalidOperationException("wrapper_exited_before_freeze");
            frozen=true;
            // All members are suspended, so the census cannot grow. Release our query reference
            // before the normal retained launcher handle is killed. Only production kill-on-close stops members.
            CloseHandle(job);job=IntPtr.Zero;jobClosedBeforeStop=true;
            File.WriteAllText(evidence+".ready","FROZEN_JOB_HANDLE_CLOSED");
            long readyAt=clock.ElapsedMilliseconds;
            while(clock.ElapsedMilliseconds-readyAt<15000) {
                wrapperExited=WaitForSingleObject(wrapper,0)==0;
                allExited=true;foreach(IntPtr handle in retained)if(WaitForSingleObject(handle,0)!=0)allExited=false;
                if(wrapperExited&&allExited)break;
                System.Threading.Thread.Sleep(20);
            }
        }catch{}
        finally {
            foreach(IntPtr handle in retained){if(WaitForSingleObject(handle,0)!=0)NtResumeProcess(handle);CloseHandle(handle);}
            if(job!=IntPtr.Zero)CloseHandle(job);
            if(wrapper!=IntPtr.Zero)CloseHandle(wrapper);
            try{File.Delete(control);File.Delete(control+".ready");File.Delete(evidence+".freeze");File.Delete(evidence+".ready");}catch{}
        }
        bool complete=frozen&&jobClosedBeforeStop&&allExited&&wrapperExited;
        string json="{\"status\":\""+(complete?"COMPLETE":"INCOMPLETE")+"\",\"allMembersExited\":"+allExited.ToString().ToLowerInvariant()+",\"wrapperExited\":"+wrapperExited.ToString().ToLowerInvariant()+",\"frozenMemberCount\":"+retained.Count+",\"jobHandleClosedBeforeStop\":"+jobClosedBeforeStop.ToString().ToLowerInvariant()+",\"observationHandlesClosed\":true}";
        File.WriteAllText(evidence+".writing",json);File.Move(evidence+".writing",evidence);
    }
}
"@
[ArenaJobWitness]::Observe($ControlPath,$EvidencePath)
