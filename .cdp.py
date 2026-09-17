import requests,json,asyncio,websockets,base64,os
j=requests.get('http://127.0.0.1:9222/json/list',timeout=2).json(); t=next(x for x in j if '127.0.0.1:8765/demo' in x['url']); wsurl=t['webSocketDebuggerUrl']
async def main():
 async with websockets.connect(wsurl,max_size=100_000_000,open_timeout=2,close_timeout=1) as ws:
  await ws.send(json.dumps({'id':1,'method':'Page.captureScreenshot','params':{'format':'png'}}))
  while True:
   x=json.loads(await asyncio.wait_for(ws.recv(),timeout=5))
   if x.get('id')==1:
    p=os.path.join(os.getcwd(),'cdp-shot.png'); open(p,'wb').write(base64.b64decode(x['result']['data'])); print('saved',p,os.path.getsize(p),flush=True); return
asyncio.run(main())
