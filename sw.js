// One service worker for the whole site.
// Pages and data: network first, cached copy when offline or when the network is slow or failing.
// Map tiles, the local Leaflet copy and font files: cache first. Postcard photos are not cached.
// Any storage failure falls back to a plain network fetch, so broken storage never blocks the site.
// Cache names carry no version: pages refresh on every online visit, and tile, font and lib URLs never change content.
const PAGES='lgk-pages', STATIC='lgk-static', KEEP=[PAGES,STATIC];
const GAMES=['','reading/','dibels/','math/','map_world/','map_us/'];
const CORE=GAMES.flatMap(g=>[g+'index.html',g+'manifest.json',g+'icon-192.png',g+'apple-touch-icon.png']).concat(GAMES.slice(1).map(g=>g+'icon.svg'));
const LIBS=['lib/leaflet-1.9.4.min.js'];
// Warmed in the background when the landing page asks, so a map opened offline is not blank.
const WARM_DATA=['map_world/places.json','map_world/rivers.json','map_world/lakes.json','map_world/countries_hi.json','map_us/places.json','map_us/rivers.json','map_us/lakes.json','map_us/states_hi.json'];
const WARM_TILES=[['map_world',0,3,[-90,-180,90,180]],['map_us',2,4,[11.25,-135,56.25,-56.25]]];

// One cache key per page: folder URLs map to their index.html, and query strings (?v=...) are dropped,
// so the copy refreshed on each visit is the one served offline, whichever form the launch URL takes.
const pageKey=u=>u.origin+u.pathname+(u.pathname.endsWith('/')?'index.html':'');
const abs=p=>new URL(p,location.href);
const put=(name,key,res)=>caches.open(name).then(c=>c.put(key,res)).catch(()=>{});
const get=(name,key)=>caches.open(name).then(c=>c.match(key)).catch(()=>null);
const store=(name,key,url,opts)=>fetch(url,opts).then(res=>{ if(res.ok) return put(name,key,res); }).catch(()=>{});

self.addEventListener('install',e=>{ self.skipWaiting(); e.waitUntil(Promise.allSettled([
  ...CORE.map(p=>store(PAGES,pageKey(abs(p)),p,{cache:'no-cache'})),
  ...LIBS.map(p=>store(STATIC,abs(p).href,p))
])); });
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  try{ for(const k of await caches.keys()) if(k.startsWith('lgk-')&&!KEEP.includes(k)) await caches.delete(k); }catch(err){}
  await self.clients.claim();
})()));

async function warm(){
  const jobs=WARM_DATA.map(p=>[PAGES,pageKey(abs(p)),p]);
  for(const [m,z0,z1,[s,w,n,e]] of WARM_TILES) for(let z=z0;z<=z1;z++){
    const d=180/2**z, xs=Math.floor((w+180)/d), xe=Math.ceil((e+180)/d)-1, ys=Math.floor((90-n)/d), ye=Math.ceil((90-s)/d)-1;
    for(let x=xs;x<=xe;x++) for(let y=ys;y<=ye;y++){ const p=`${m}/tiles/${z}/${x}/${y}.jpg`; jobs.push([STATIC,abs(p).href,p]); }
  }
  for(let i=0;i<jobs.length;i+=8) await Promise.allSettled(jobs.slice(i,i+8).map(async([name,key,p])=>{ if(!(await get(name,key))) await store(name,key,p); }));
}
self.addEventListener('message',e=>{ if(e.data==='warm') e.waitUntil(warm()); });

const offlinePage=()=>new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="margin:0;padding:48px 24px;font:22px/1.4 system-ui,sans-serif;text-align:center;background:#F4F1EA;color:#1F2A37">This page needs the internet the first time. Connect once and open it, and it will work offline after that.<p><a href="${self.registration.scope}" style="color:inherit">All games</a></p></body>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});

function cacheFirst(e,req){
  const key=req.url;
  return get(STATIC,key).then(hit=>hit||fetch(req).then(res=>{
    if(res.ok) e.waitUntil(put(STATIC,key,res.clone()));
    return res;
  }).catch(()=>Response.error()));
}
function networkFirst(e,req,name,key,netReq){
  const net=fetch(netReq||req);
  // Clone before anything else reads the body, and keep the worker alive until the write finishes.
  e.waitUntil(net.then(res=>res.ok&&put(name,key,res.clone())).catch(()=>{}));
  return get(name,key).then(cached=>{
    const fallback=()=>cached||(req.mode==='navigate'?offlinePage():Response.error());
    const fresh=net.then(res=>res.status>=500&&cached?cached:res,fallback);
    if(!cached) return fresh;
    // A cached copy of a different data version (?v=) is only an offline fallback, never a slow-network one.
    const cachedSearch=cached.url?new URL(cached.url).search:'';
    if(cachedSearch&&cachedSearch!==new URL(req.url).search) return fresh;
    // Slow connection: fall back to the cached copy after 4 s.
    return Promise.race([fresh,new Promise(r=>setTimeout(()=>r(cached),4000))]);
  });
}

self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET') return;
  const u=new URL(req.url);
  if(u.hostname==='fonts.gstatic.com') return e.respondWith(cacheFirst(e,req));
  // Font CSS: fetched with CORS so its status is known and it is not stored as an opaque (quota-padded) entry.
  if(u.hostname==='fonts.googleapis.com') return e.respondWith(networkFirst(e,req,STATIC,req.url,new Request(req.url,{mode:'cors',credentials:'omit'})));
  if(!req.url.startsWith(self.registration.scope)) return;
  // A folder link without its trailing slash: redirect as GitHub Pages does, so relative links keep working offline.
  if(req.mode==='navigate'&&!u.pathname.endsWith('/')&&!/\.[a-z0-9]+$/i.test(u.pathname)) return e.respondWith(Response.redirect(u.origin+u.pathname+'/'+u.search,301));
  if(u.pathname.includes('/tiles/')||u.pathname.includes('/lib/')) return e.respondWith(cacheFirst(e,req));
  e.respondWith(networkFirst(e,req,PAGES,pageKey(u)));
});
