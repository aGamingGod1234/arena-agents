import socket,sys,time,json,datetime,pathlib
base=int(sys.argv[1]);start=time.time()
while True:
 held=[]
 for port in range(base,base+3):
  with socket.socket() as s:
   s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
   try:s.bind(('127.0.0.1',port))
   except OSError:held.append(port)
 if not held:break
 if time.time()-start>180:raise RuntimeError(f'Slot acquired but ports still occupied after 180s: {held}')
 print(f'Waiting for previous slot user to release ports {held}',flush=True);time.sleep(2)
print('Slot ports free after %.1fs'%(time.time()-start),flush=True)
