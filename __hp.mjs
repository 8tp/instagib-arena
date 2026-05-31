import { chromium } from 'playwright';
const B='http://127.0.0.1:8811';
const b=await chromium.launch({headless:true,channel:'chrome'});
const p=await b.newPage({viewport:{width:420,height:520}});
await p.goto(`${B}/lockerlab`,{waitUntil:'networkidle'});
await p.waitForTimeout(3800);
// drive via window.__lockerlab to set hat directly. HATS idx: 0 none,1 cap,2 baseball,3 hardhat,4 graduation,5 tophat,6 propeller,7 wizard
const setHat=async(h)=>{ await p.evaluate((h)=>{const L=window.__lockerlab; L.idx.current.h=h; L.idx.current.e=0; L.refresh();}, h); await p.waitForTimeout(1300); };
await setHat(1); await p.screenshot({path:'/tmp/hp_cap.png', clip:{x:90,y:30,width:240,height:200}});
await setHat(2); await p.screenshot({path:'/tmp/hp_baseball.png', clip:{x:90,y:30,width:240,height:200}});
await setHat(6); await p.screenshot({path:'/tmp/hp_propeller.png', clip:{x:90,y:30,width:240,height:200}});
await b.close(); console.log('done');
