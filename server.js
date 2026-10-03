const http=require('http'),zlib=require('zlib'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{DatabaseSync}=require('node:sqlite');
const E=process.env,PROD=E.NODE_ENV==='production',DAY=864e5,PORT=E.PORT||3000,BASE=E.BASE_URL||'http://localhost:'+PORT;
const CATS=['Remont i budowa','Elektryka','Hydraulika','Sprzątanie','Ogród','Transport','Montaż i naprawy','Inne'];
const PACKS={10:2000,30:5000,100:15000}; // punkty -> grosze
const MAXR=5,cost=b=>b<=300?3:b<=800?5:8;
const db=new DatabaseSync(E.DB_FILE||'zlecenka.db');
db.exec(`pragma journal_mode=wal;pragma foreign_keys=on;
create table if not exists users(id integer primary key,email text unique,name text,role text,salt text,hash text,pts integer default 0,created integer);
create table if not exists sessions(tok text primary key,uid integer references users(id) on delete cascade,exp integer);
create table if not exists jobs(id integer primary key,uid integer references users(id),title text,cat text,city text,budget integer,descr text,phone text,t integer);
create table if not exists unlocks(id integer primary key,jid integer references jobs(id),uid integer references users(id),cost integer,t integer,unique(jid,uid));
create table if not exists ledger(id integer primary key,uid integer references users(id),t integer,d integer,note text,ref text unique);
create table if not exists reports(id integer primary key,unlock_id integer unique references unlocks(id),t integer,note text,status text default 'pending');`);
db.exec('create table if not exists tokens(tok text primary key,uid integer references users(id) on delete cascade,kind text,exp integer)');
try{db.exec('alter table users add column verified integer default 0');db.exec('update users set verified=1')}catch(e){}
db.exec(`create table if not exists photos(id integer primary key,jid integer references jobs(id) on delete cascade,data text);
create index if not exists i_photos_jid on photos(jid);
create table if not exists msgs(id integer primary key,unlock_id integer references unlocks(id) on delete cascade,from_uid integer,txt text,t integer);
create index if not exists i_msgs_k on msgs(unlock_id);
create table if not exists profiles(uid integer primary key references users(id) on delete cascade,bio text,cats text,city text);
create table if not exists reviews(id integer primary key,unlock_id integer unique references unlocks(id),wid integer,zid integer,rating integer,txt text,t integer);
create table if not exists subs(uid integer primary key references users(id) on delete cascade,cats text,city text);
create index if not exists i_jobs_t on jobs(t);create index if not exists i_ledger_uid on ledger(uid);create index if not exists i_unlocks_uid on unlocks(uid);create index if not exists i_sess_uid on sessions(uid);create index if not exists i_rev_wid on reviews(wid)`);
try{db.exec("alter table jobs add column status text default 'open'")}catch(e){}
try{db.exec('alter table jobs add column exp integer')}catch(e){}
try{db.exec('alter table users add column banned integer default 0')}catch(e){}
db.exec('update jobs set exp=t+30*86400000 where exp is null');
const Q=s=>db.prepare(s);
const tx=f=>{db.exec('begin immediate');try{const r=f();db.exec('commit');return r}catch(e){db.exec('rollback');throw e}};
const credit=(uid,d,note,ref)=>{Q('insert into ledger(uid,t,d,note,ref) values(?,?,?,?,?)').run(uid,Date.now(),d,note,ref);Q('update users set pts=pts+? where id=?').run(d,uid)};
const rnd=n=>crypto.randomBytes(n).toString('hex'),hashPw=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
const same=(a,b)=>a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
class Err extends Error{constructor(c,m){super(m);this.c=c}}
const need=(c,m)=>{if(!c)throw new Err(400,m||'Nieprawidłowe dane')};
const hits=new Map(),limit=(q,k,max,ms)=>{const x=q.ip+k,n=Date.now(),a=(hits.get(x)||[]).filter(t=>t>n-ms);if(a.length>=max)throw new Err(429,'Zbyt wiele prób, spróbuj później');a.push(n);hits.set(x,a)};
const ck=q=>((q.headers.cookie||'').split('; ').find(c=>c.startsWith('sid='))||'').slice(4);
const user=q=>{const t=ck(q);return t&&Q('select u.* from sessions s join users u on u.id=s.uid where s.tok=? and s.exp>? and u.banned=0').get(t,Date.now())};
const login=(s,uid)=>{const t=rnd(32);Q('insert into sessions values(?,?,?)').run(t,uid,Date.now()+30*DAY);s.cookie=`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*86400}${PROD?'; Secure':''}`};
const me=u=>({name:u.name,email:u.email,role:u.role,pts:u.pts,verified:!!u.verified});
const GOOGLE=!!(E.GOOGLE_CLIENT_ID&&E.GOOGLE_CLIENT_SECRET),ck2=(q,n)=>((q.headers.cookie||'').split('; ').find(c=>c.startsWith(n+'='))||'').slice(n.length+1);
const MAIL=!!(E.RESEND_API_KEY||E.MAIL_DEV),sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const sendMail=async(to,subject,text)=>{if(!E.RESEND_API_KEY){console.log('[mail dev]',to,subject,text);return}
  const x=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+E.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:E.MAIL_FROM,to:[to],subject,text})});if(!x.ok)console.error('mail',x.status,await x.text())};
const mkTok=(uid,kind,ttl)=>{const t=rnd(32);Q('insert into tokens values(?,?,?,?)').run(sha(t),uid,kind,Date.now()+ttl);return t};
const useTok=(t,kind)=>{const h=sha(String(t||'')),r=Q('select * from tokens where tok=? and kind=? and exp>?').get(h,kind,Date.now());if(r)Q('delete from tokens where tok=?').run(h);return r};
const sendVerify=(uid,email)=>sendMail(email,'Zlecenka: potwierdź adres e-mail','Potwierdź adres e-mail, otwierając link (ważny 48 godzin):\n'+BASE+'/#/weryfikacja/'+mkTok(uid,'verify',2*DAY)+'\n').catch(console.error);
const ver=u=>need(u.verified,'Potwierdź adres e-mail. Link wysłaliśmy na Twoją skrzynkę.');
const notify=j=>{if(!MAIL)return;const city=j.city.toLowerCase(),to=Q("select u.email,s.cats,s.city from subs s join users u on u.id=s.uid where u.verified=1 and u.role='w'").all().filter(x=>(!x.cats||x.cats.split(',').includes(j.cat))&&(!x.city||city.includes(x.city.toLowerCase()))).slice(0,200);
  (async()=>{for(const x of to){await sendMail(x.email,'Nowe zlecenie: '+j.title,j.cat+', '+j.city+', budżet '+j.budget+' zł. Odblokowanie: '+cost(j.budget)+' pkt.\n'+BASE+'/#/zlecenie/'+j.id+'\n\nPowiadomienia wyłączysz w swoim profilu.').catch(console.error);await new Promise(r=>setTimeout(r,600))}})()};
const jobRow=(j,u)=>({id:j.id,title:j.title,cat:j.cat,city:j.city,budget:j.budget,descr:j.descr,t:j.t,resp:j.resp,cost:cost(j.budget),
  open:!!j.mine_unlock,own:!!u&&j.uid===u.id,status:j.status,exp:j.exp});
const JQ=`select j.*,(select count(*) from unlocks x where x.jid=j.id) resp,(select 1 from unlocks x where x.jid=j.id and x.uid=?) mine_unlock from jobs j`;

const routes=[];const R=(m,p,f)=>routes.push([m,new RegExp('^'+p+'$'),f]);
R('POST','/api/register',(q,s,b)=>{limit(q,'reg',10,36e5);const e=String(b.email||'').trim().toLowerCase(),n=String(b.name||'').trim().slice(0,80),p=String(b.password||'');
  need(n.length>=2&&/^\S+@\S+\.\S+$/.test(e)&&p.length>=8&&['z','w'].includes(b.role));
  if(Q('select 1 from users where email=?').get(e))throw new Err(409,'Konto z tym adresem już istnieje. Zaloguj się.');
  const salt=rnd(16),uid=tx(()=>{const id=Q('insert into users(email,name,role,salt,hash,created,verified) values(?,?,?,?,?,?,?)').run(e,n,b.role,salt,hashPw(p,salt),Date.now(),MAIL?0:1).lastInsertRowid;
    if(b.role==='w')credit(id,10,'Punkty startowe','start:'+id);return id});login(s,uid);if(MAIL)sendVerify(uid,e);return{ok:true}});
R('POST','/api/login',(q,s,b)=>{limit(q,'login',10,9e5);const u=Q('select * from users where email=?').get(String(b.email||'').trim().toLowerCase());
  if(!u||!same(hashPw(String(b.password||''),u.salt),u.hash))throw new Err(401,'Nieprawidłowy e-mail lub hasło.');need(!u.banned,'Konto zostało zablokowane.');login(s,u.id);return{ok:true}});
R('POST','/api/logout',(q,s)=>{Q('delete from sessions where tok=?').run(ck(q));s.cookie='sid=; Max-Age=0; Path=/';return{ok:true}});
R('GET','/api/me',(q)=>{const u=user(q);return u?{user:me(u),mail:MAIL,google:GOOGLE,ledger:Q('select d,note,t from ledger where uid=? order by id desc limit 50').all(u.id)}:{user:null,mail:MAIL,google:GOOGLE}});
R('GET','/api/jobs',(q)=>{const u=user(q),p=new URL(q.url,'http://x').searchParams,w=["j.status='open'",'j.exp>?'],a=[Date.now()],lk=v=>'%'+v.replace(/[%_]/g,'')+'%';
  if(CATS.includes(p.get('cat'))){w.push('j.cat=?');a.push(p.get('cat'))}
  const c=(p.get('city')||'').trim().slice(0,60),t=(p.get('q')||'').trim().slice(0,60);
  if(c){w.push('j.city like ?');a.push(lk(c))}if(t){w.push('(j.title like ? or j.descr like ?)');a.push(lk(t),lk(t))}
  if(+p.get('min')>0){w.push('j.budget>=?');a.push(+p.get('min'))}
  const paged=p.has('page'),pg=Math.max(1,+p.get('page')||1),lim=paged?20:300,W=' where '+w.join(' and ');
  return{total:Q('select count(*) n from jobs j'+W).get(...a).n,page:pg,per:lim,jobs:Q(JQ+W+' order by j.t desc limit ? offset ?').all(u?u.id:0,...a,lim,(pg-1)*lim).map(j=>jobRow(j,u))}});
const thr=(q,id)=>{const u=user(q);need(u,'Zaloguj się');const k=Q('select k.*,j.uid owner,j.title from unlocks k join jobs j on j.id=k.jid where k.id=?').get(id);if(!k||(k.uid!==u.id&&k.owner!==u.id))throw new Err(403,'Brak dostępu');return[u,k]};
R('GET','/api/threads/(\\d+)',(q,s,b,m)=>{const[u]=thr(q,m[1]);return{messages:Q('select txt,t,(from_uid=?) mine from msgs where unlock_id=? order by id limit 200').all(u.id,m[1])}});
R('POST','/api/threads/(\\d+)',(q,s,b,m)=>{const[u,k]=thr(q,m[1]);ver(u);limit(q,'msg',60,36e5);const t=String(b.text||'').trim().slice(0,1000);need(t,'Wpisz wiadomość');
  const last=Q('select t from msgs where unlock_id=? and from_uid=? order by id desc limit 1').get(k.id,u.id);
  Q('insert into msgs(unlock_id,from_uid,txt,t) values(?,?,?,?)').run(k.id,u.id,t,Date.now());
  if(MAIL&&(!last||Date.now()-last.t>6e5)){const o=Q('select email from users where id=?').get(u.id===k.uid?k.owner:k.uid);if(o)sendMail(o.email,'Zlecenka: nowa wiadomość','Nowa wiadomość w zleceniu "'+k.title+'":\n'+BASE+'/#/zlecenie/'+k.jid+'\n').catch(console.error)}
  return{ok:true}});
R('POST','/api/jobs/(\\d+)/edit',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');const j=Q('select * from jobs where id=? and uid=?').get(m[1],u.id);if(!j)throw new Err(404,'Nie znaleziono zlecenia');
  const t=String(b.title||j.title).trim().slice(0,100),d=String(b.descr==null?j.descr:b.descr).trim().slice(0,1000),bu=b.budget?Math.round(+b.budget):j.budget;need(t.length>=5&&bu>0&&bu<=1e6);
  need(bu===j.budget||!Q('select 1 from unlocks where jid=?').get(j.id),'Nie można zmienić budżetu po odblokowaniu zlecenia');
  Q('update jobs set title=?,descr=?,budget=? where id=?').run(t,d||'Brak opisu.',bu,j.id);return{ok:true}});
R('POST','/api/jobs/(\\d+)/delete',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');const j=Q('select * from jobs where id=? and uid=?').get(m[1],u.id);if(!j)throw new Err(404,'Nie znaleziono zlecenia');
  need(!Q('select 1 from unlocks where jid=?').get(j.id),'Zlecenie ma odblokowania. Zmień jego status na zamknięte.');Q('delete from jobs where id=?').run(j.id);return{ok:true}});
R('GET','/api/account/export',(q)=>{const u=user(q);need(u,'Zaloguj się');const i=u.id;return{konto:{email:u.email,name:u.name,role:u.role,created:u.created},profil:Q('select bio,cats,city from profiles where uid=?').get(i)||null,zlecenia:Q('select title,cat,city,budget,descr,phone,t,status from jobs where uid=?').all(i),odblokowania:Q('select jid,cost,t from unlocks where uid=?').all(i),portfel:Q('select d,note,t from ledger where uid=?').all(i),wiadomosci:Q('select unlock_id,txt,t from msgs where from_uid=?').all(i),opinie_wystawione:Q('select unlock_id,rating,txt,t from reviews where zid=?').all(i),opinie_otrzymane:Q('select rating,txt,t from reviews where wid=?').all(i)}});
R('POST','/api/account/delete',(q,s,b)=>{const u=user(q);need(u,'Zaloguj się');limit(q,'del',5,36e5);need(String(b.email||'').trim().toLowerCase()===u.email,'Wpisz swój adres e-mail, aby potwierdzić');
  tx(()=>{const i=u.id;Q('delete from sessions where uid=?').run(i);Q('delete from tokens where uid=?').run(i);Q('delete from profiles where uid=?').run(i);Q('delete from subs where uid=?').run(i);
    Q('update msgs set txt=? where from_uid=?').run('[usunięto]',i);
    Q('select id from jobs where uid=?').all(i).forEach(j=>{if(Q('select 1 from unlocks where jid=?').get(j.id))Q("update jobs set phone='',descr='[usunięto]',status='closed' where id=?").run(j.id);else Q('delete from jobs where id=?').run(j.id)});
    Q("update users set email=?,name='Usunięty użytkownik',salt=?,hash=?,verified=0,banned=1 where id=?").run('usuniety-'+i+'@usuniety.invalid',rnd(16),rnd(32),i)});
  s.cookie='sid=; Max-Age=0; Path=/';return{ok:true}});
R('GET','/api/admin/overview',(q)=>{adm(q);const n=x=>Q(x).get().n;return{stats:{users:n('select count(*) n from users where banned=0'),jobs:n("select count(*) n from jobs where status='open' and exp>"+Date.now()),unlocks:n('select count(*) n from unlocks'),revenue:n("select coalesce(sum(case d when 10 then 20 when 30 then 50 when 100 then 150 else 0 end),0) n from ledger where ref like 'stripe:%'")},
  users:Q('select id,email,name,role,pts,banned from users order by id desc limit 100').all(),jobs:Q('select j.id,j.title,j.city,j.status,u.email,(select count(*) from unlocks where jid=j.id) resp from jobs j join users u on u.id=j.uid order by j.id desc limit 100').all()}});
R('POST','/api/admin/users/(\\d+)/ban',(q,s,b,m)=>{adm(q);Q('update users set banned=? where id=?').run(b.ban?1:0,m[1]);if(b.ban)Q('delete from sessions where uid=?').run(m[1]);return{ok:true}});
R('POST','/api/admin/jobs/(\\d+)/remove',(q,s,b,m)=>{adm(q);Q("update jobs set status='closed' where id=?").run(m[1]);return{ok:true}});
R('GET','/api/my-jobs',(q)=>{const u=user(q);need(u,'Zaloguj się');return{jobs:Q(JQ+' where j.uid=? order by j.t desc limit 200').all(u.id,u.id).map(j=>jobRow(j,u))}});
R('POST','/api/jobs/(\\d+)/status',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');need(['open','progress','done','closed'].includes(b.status));
  const j=Q('select * from jobs where id=? and uid=?').get(m[1],u.id);if(!j)throw new Err(404,'Nie znaleziono zlecenia');
  Q('update jobs set status=?,exp=? where id=?').run(b.status,b.status==='open'?Date.now()+30*DAY:j.exp,j.id);return{ok:true}});
R('GET','/api/jobs/(\\d+)/responders',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');if(!Q('select 1 from jobs where id=? and uid=?').get(m[1],u.id))throw new Err(403,'Brak dostępu');
  return{responders:Q('select k.id unlock_id,u.id wid,u.name,p.bio,p.city,(select round(avg(rating),1) from reviews where wid=u.id) avg,(select count(*) from reviews where wid=u.id) n,(select 1 from reviews where unlock_id=k.id) reviewed from unlocks k join users u on u.id=k.uid left join profiles p on p.uid=u.id where k.jid=? order by k.t').all(m[1])}});
R('POST','/api/jobs/(\\d+)/review',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');limit(q,'rv',20,36e5);
  const k=Q('select k.* from unlocks k join jobs j on j.id=k.jid where k.id=? and j.id=? and j.uid=?').get(+b.unlock_id,m[1],u.id);if(!k)throw new Err(404,'Nie znaleziono');
  const r=Math.round(+b.rating);need(r>=1&&r<=5,'Ocena od 1 do 5');if(Q('select 1 from reviews where unlock_id=?').get(k.id))throw new Err(400,'Już oceniono');
  Q('insert into reviews(unlock_id,wid,zid,rating,txt,t) values(?,?,?,?,?,?)').run(k.id,k.uid,u.id,r,String(b.text||'').trim().slice(0,500),Date.now());return{ok:true}});
R('GET','/api/workers/(\\d+)',(q,s,b,m)=>{const w=Q("select u.id,u.name,u.created,p.bio,p.cats,p.city from users u left join profiles p on p.uid=u.id where u.id=? and u.role='w'").get(m[1]);if(!w)throw new Err(404,'Nie znaleziono');
  const rv=Q("select r.rating,r.txt,r.t,substr(z.name,1,instr(z.name||' ',' ')-1) name from reviews r join users z on z.id=r.zid where r.wid=? order by r.id desc limit 30").all(w.id);
  return{worker:{id:w.id,name:w.name,bio:w.bio||'',city:w.city||'',cats:w.cats?w.cats.split(','):[],since:w.created},avg:rv.length?Math.round(rv.reduce((a,x)=>a+x.rating,0)/rv.length*10)/10:null,reviews:rv}});
R('GET','/api/profile',(q)=>{const u=user(q);need(u,'Zaloguj się');const p=Q('select bio,cats,city from profiles where uid=?').get(u.id)||{};return{id:u.id,bio:p.bio||'',city:p.city||'',cats:p.cats?p.cats.split(','):[],notify:!!Q('select 1 from subs where uid=?').get(u.id),mail:MAIL}});
R('POST','/api/profile',(q,s,b)=>{const u=user(q);need(u,'Zaloguj się');need(u.role==='w','Profil mają wykonawcy');limit(q,'prof',30,36e5);
  const cs=(Array.isArray(b.cats)?b.cats:[]).filter(c=>CATS.includes(c)).join(','),ci=String(b.city||'').trim().slice(0,60),bio=String(b.bio||'').trim().slice(0,600);
  Q('insert or replace into profiles(uid,bio,cats,city) values(?,?,?,?)').run(u.id,bio,cs,ci);
  if(b.notify)Q('insert or replace into subs(uid,cats,city) values(?,?,?)').run(u.id,cs,ci);else Q('delete from subs where uid=?').run(u.id);return{ok:true}});
R('GET','/api/jobs/(\\d+)',(q,s,b,m)=>{const u=user(q),j=Q(JQ+' where j.id=?').get(u?u.id:0,m[1]);if(!j)throw new Err(404,'Nie znaleziono');
  const r=jobRow(j,u);if(r.open||r.own)r.phone=j.phone;r.photos=Q('select id from photos where jid=?').all(j.id).map(x=>x.id);if(u)r.unlock_id=(Q('select id from unlocks where jid=? and uid=?').get(j.id,u.id)||{}).id;return r});
R('POST','/api/jobs',(q,s,b)=>{const u=user(q);need(u,'Zaloguj się');need(u.role==='z','Dodawanie zleceń jest dla zleceniodawców');ver(u);limit(q,'job',10,36e5);
  const t=String(b.title||'').trim().slice(0,100),c=String(b.city||'').trim().slice(0,60),d=String(b.descr||'').trim().slice(0,1000),ph=String(b.phone||'').trim().slice(0,20),bu=Math.round(+b.budget);
  need(t.length>=5&&c.length>=2&&CATS.includes(b.cat)&&bu>0&&bu<=1e6&&ph.replace(/\D/g,'').length>=9);
  const id=Q("insert into jobs(uid,title,cat,city,budget,descr,phone,t,exp,status) values(?,?,?,?,?,?,?,?,?,'open')").run(u.id,t,b.cat,c,bu,d||'Brak opisu.',ph,Date.now(),Date.now()+30*DAY).lastInsertRowid;(Array.isArray(b.photos)?b.photos:[]).slice(0,3).forEach(x=>{const m=/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(x));if(m&&m[1].length<200e3&&Buffer.from(m[1],'base64')[0]===0xFF)Q('insert into photos(jid,data) values(?,?)').run(id,m[1])});notify({id,title:t,cat:b.cat,city:c,budget:bu});return{id}});
R('POST','/api/jobs/(\\d+)/unlock',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');need(u.role==='w','Odblokowanie jest dostępne na koncie wykonawcy');ver(u);limit(q,'unl',60,36e5);
  return tx(()=>{const j=Q(JQ+' where j.id=?').get(u.id,m[1]),w=Q('select pts from users where id=?').get(u.id);
    if(!j)throw new Err(404,'Nie znaleziono zlecenia');if(j.uid===u.id)throw new Err(400,'To Twoje zlecenie');
    if(j.mine_unlock)throw new Err(400,'Już odblokowano');if(j.status!=='open'||j.exp<Date.now())throw new Err(400,'To zlecenie jest zamknięte lub wygasło');if(j.resp>=MAXR)throw new Err(400,'To zlecenie ma już komplet odpowiedzi');
    const c=cost(j.budget);if(w.pts<c)throw new Err(402,'Brakuje Ci '+(c-w.pts)+' pkt');
    const id=Q('insert into unlocks(jid,uid,cost,t) values(?,?,?,?)').run(j.id,u.id,c,Date.now()).lastInsertRowid;
    credit(u.id,-c,'Odblokowano: '+j.title,'unlock:'+id);return{phone:j.phone}})});
R('POST','/api/jobs/(\\d+)/report',(q,s,b,m)=>{const u=user(q);need(u,'Zaloguj się');limit(q,'rep',10,36e5);
  const k=Q('select * from unlocks where jid=? and uid=?').get(m[1],u.id);need(k,'Nie odblokowano tego zlecenia');need(Date.now()-k.t<7*DAY,'Na zgłoszenie jest 7 dni od odblokowania');
  if(Q('select 1 from reports where unlock_id=?').get(k.id))throw new Err(400,'Zgłoszenie już istnieje');
  Q('insert into reports(unlock_id,t,note) values(?,?,?)').run(k.id,Date.now(),String(b.note||'').slice(0,300));return{ok:true}});
R('POST','/api/verify',(q,s,b)=>{limit(q,'ver',20,36e5);const t=useTok(b.token,'verify');need(t,'Link jest nieważny lub wygasł.');Q('update users set verified=1 where id=?').run(t.uid);return{ok:true}});
R('POST','/api/resend-verification',(q)=>{const u=user(q);need(u,'Zaloguj się');need(MAIL,'Wysyłka e-maili jest wyłączona');limit(q,'rsv',3,36e5);if(!u.verified)sendVerify(u.id,u.email);return{ok:true}});
R('POST','/api/forgot',(q,s,b)=>{limit(q,'fg',5,36e5);need(MAIL,'Odzyskiwanie hasła jest niedostępne');const u=Q('select * from users where email=?').get(String(b.email||'').trim().toLowerCase());
  if(u)sendMail(u.email,'Zlecenka: ustaw nowe hasło','Aby ustawić nowe hasło, otwórz link (ważny godzinę):\n'+BASE+'/#/reset/'+mkTok(u.id,'reset',36e5)+'\n\nJeśli to nie Ty, zignoruj tę wiadomość.').catch(console.error);return{ok:true}});
R('POST','/api/reset',(q,s,b)=>{limit(q,'rs',10,36e5);const p=String(b.password||'');need(p.length>=8,'Hasło musi mieć co najmniej 8 znaków.');
  const t=useTok(b.token,'reset');need(t,'Link jest nieważny lub wygasł.');const salt=rnd(16);
  Q('update users set salt=?,hash=?,verified=1 where id=?').run(salt,hashPw(p,salt),t.uid);Q('delete from sessions where uid=?').run(t.uid);return{ok:true}});
// admin: ADMIN_TOKEN w nagłówku x-admin-token
const adm=q=>{need(E.ADMIN_TOKEN&&q.headers['x-admin-token']&&same(String(q.headers['x-admin-token']),E.ADMIN_TOKEN),'Brak dostępu')};
R('GET','/api/admin/reports',(q)=>{adm(q);return{reports:Q(`select r.id,r.note,r.t,r.status,k.cost,u.email,j.title,j.phone from reports r join unlocks k on k.id=r.unlock_id join users u on u.id=k.uid join jobs j on j.id=k.jid where r.status='pending' order by r.t`).all()}});
R('POST','/api/admin/reports/(\\d+)',(q,s,b,m)=>{adm(q);return tx(()=>{const r=Q("select r.*,k.uid,k.cost from reports r join unlocks k on k.id=r.unlock_id where r.id=? and r.status='pending'").get(m[1]);if(!r)throw new Err(404,'Nie znaleziono');
  if(b.approve)credit(r.uid,r.cost,'Zwrot punktów po zgłoszeniu','refund:'+r.unlock_id);
  Q('update reports set status=? where id=?').run(b.approve?'approved':'rejected',r.id);return{ok:true}})});
// płatności Stripe Checkout (bez SDK)
R('POST','/api/checkout',async(q,s,b)=>{const u=user(q);need(u,'Zaloguj się');need(u.role==='w','Punkty kupują wykonawcy');ver(u);limit(q,'co',20,36e5);
  const n=+b.pack,g=PACKS[n];need(g);if(!E.STRIPE_SECRET_KEY)throw new Err(503,'Płatności są chwilowo niedostępne.');
  const p=new URLSearchParams({mode:'payment',success_url:BASE+'/?paid=1#/portfel',cancel_url:BASE+'/#/portfel',client_reference_id:String(u.id),customer_email:u.email,
    'metadata[pts]':String(n),'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'pln','line_items[0][price_data][unit_amount]':String(g),'line_items[0][price_data][product_data][name]':n+' pkt w Zlecence'});
  const x=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+E.STRIPE_SECRET_KEY},body:p}),j=await x.json();
  if(!x.ok){console.error('stripe',j.error&&j.error.message);throw new Err(502,'Nie udało się rozpocząć płatności.')}return{url:j.url}});
const stripeHook=(q,raw)=>{const sig=Object.fromEntries(String(q.headers['stripe-signature']||'').split(',').map(x=>x.split('=')));
  need(E.STRIPE_WEBHOOK_SECRET&&sig.t&&sig.v1&&Math.abs(Date.now()/1e3-sig.t)<300&&same(crypto.createHmac('sha256',E.STRIPE_WEBHOOK_SECRET).update(sig.t+'.'+raw).digest('hex'),sig.v1),'Zły podpis');
  const ev=JSON.parse(raw),o=ev.data&&ev.data.object;
  if(ev.type==='checkout.session.completed'&&o.payment_status==='paid'){const n=+o.metadata.pts,uid=+o.client_reference_id;
    if(PACKS[n]===o.amount_total&&Q('select 1 from users where id=?').get(uid)){try{tx(()=>credit(uid,n,'Zakup pakietu '+n+' pkt','stripe:'+o.id))}catch(e){if(!/UNIQUE/.test(e.message))throw e}}}
  return{ok:true}};

const pub=path.join(__dirname,'public'),MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const HDR={'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"};
const h=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const slug=t=>String(t).toLowerCase().replace(/[ąćęłńóśźż]/g,c=>({'ą':'a','ć':'c','ę':'e','ł':'l','ń':'n','ó':'o','ś':'s','ź':'z','ż':'z'}[c])).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const CS=Object.fromEntries(CATS.map(c=>[slug(c),c]));
const page=(title,desc,body,canon,noidx)=>'<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+h(title)+'</title><meta name="description" content="'+h(desc)+'"><link rel="canonical" href="'+BASE+canon+'">'+(noidx?'<meta name="robots" content="noindex">':'')+'<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 20px;color:#0B1B3A}a{color:#1D6FF2}li{margin:8px 0}.b{display:inline-block;background:#1D6FF2;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700}</style></head><body><p><a href="/">← Zlecenka</a></p>'+body+'</body></html>';
const seo=p=>{let m;const open="status='open' and exp>"+Date.now(),html='text/html; charset=utf-8',nf={c:404,t:'text/plain',b:'Nie znaleziono'};
  if(m=p.match(/^\/foto\/(\d+)$/)){const r=Q('select data from photos where id=?').get(m[1]);return r?{c:200,t:'image/jpeg',b:Buffer.from(r.data,'base64')}:nf}
  if(p==='/healthz')return{c:200,t:'text/plain',b:'ok'};
  if(p==='/robots.txt')return{c:200,t:'text/plain',b:'User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: '+BASE+'/sitemap.xml\n'};
  if(p==='/sitemap.xml'){const u=['/'];CATS.forEach(c=>u.push('/uslugi/'+slug(c)));Q('select id,city,cat from jobs where '+open).all().forEach(j=>{u.push('/zlecenie/'+j.id,'/uslugi/'+slug(j.cat)+'/'+slug(j.city))});
    return{c:200,t:'application/xml',b:'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+[...new Set(u)].map(x=>'<url><loc>'+BASE+x+'</loc></url>').join('')+'</urlset>'}}
  if(m=p.match(/^\/uslugi\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/)){const cat=CS[m[1]];if(!cat)return nf;
    let js=Q('select id,title,city,budget,t from jobs where cat=? and '+open+' order by t desc limit 100').all(cat),city='';
    if(m[2]){js=js.filter(j=>slug(j.city)===m[2]);city=js.length?js[0].city:''}
    const w=city?' w mieście '+city:'',ttl=cat+(city?' – '+city:'')+': aktualne zlecenia | Zlecenka';
    return{c:200,t:html,b:page(ttl,'Aktualne zlecenia: '+cat.toLowerCase()+w+'. Odblokuj kontakt do klienta i ustal szczegóły bezpośrednio.','<h1>'+h(cat)+(city?' – '+h(city):'')+'</h1><p>Aktualne zlecenia'+h(w)+'. Numer telefonu odblokujesz po założeniu konta wykonawcy.</p>'+(js.length?'<ul>'+js.map(j=>'<li><a href="/zlecenie/'+j.id+'">'+h(j.title)+'</a> · '+h(j.city)+' · do '+j.budget+' zł</li>').join('')+'</ul>':'<p>Brak aktualnych zleceń.</p>')+'<p><a class="b" href="/#/zlecenia">Zobacz wszystkie zlecenia</a></p>','/uslugi/'+m[1]+(m[2]?'/'+m[2]:''),!js.length)}}
  if(m=p.match(/^\/zlecenie\/(\d+)$/)){const j=Q('select * from jobs where id=?').get(m[1]);if(!j)return nf;const ok=j.status==='open'&&j.exp>Date.now();
    return{c:200,t:html,b:page(j.title+' – '+j.city+' | Zlecenka',j.cat+', '+j.city+', budżet do '+j.budget+' zł. '+j.descr.slice(0,100),'<h1>'+h(j.title)+'</h1><p>'+h(j.cat)+' · '+h(j.city)+' · budżet do '+j.budget+' zł</p><p>'+h(j.descr)+'</p>'+(ok?'':'<p><b>To zlecenie jest już nieaktualne.</b></p>')+'<p><a class="b" href="/#/zlecenie/'+j.id+'">Odblokuj kontakt za '+cost(j.budget)+' pkt</a></p><p><a href="/uslugi/'+slug(j.cat)+'/'+slug(j.city)+'">Więcej: '+h(j.cat)+', '+h(j.city)+'</a></p>','/zlecenie/'+j.id,!ok)}}
  return null};
const GID=E.GOOGLE_CLIENT_ID,GSEC=E.GOOGLE_CLIENT_SECRET,GRED=BASE+'/api/auth/google/callback',gfail=done=>done(302,'',{Location:'/?gerr=1#/logowanie'});
const google=async(q,s,url,done)=>{if(!GOOGLE)return gfail(done);limit(q,'gg',30,36e5);
  if(url.pathname==='/api/auth/google'){const st=rnd(16),role=url.searchParams.get('role')==='z'?'z':'w';s.cookie='gs='+st+'.'+role+'; HttpOnly; SameSite=Lax; Path=/; Max-Age=600'+(PROD?'; Secure':'');
    return done(302,'',{Location:'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:GID,redirect_uri:GRED,response_type:'code',scope:'openid email profile',state:st,prompt:'select_account'})})}
  if(url.pathname==='/api/auth/google/callback'){const c=ck2(q,'gs').split('.'),code=url.searchParams.get('code');
    if(!code||!c[0]||!same(c[0],String(url.searchParams.get('state')||'')))return gfail(done);
    const tk=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:GID,client_secret:GSEC,redirect_uri:GRED,grant_type:'authorization_code'})}).then(r=>r.json());
    if(!tk.access_token)return gfail(done);
    const g=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+tk.access_token}}).then(r=>r.json());
    if(!g.email||g.email_verified!==true)return gfail(done);
    const e=String(g.email).toLowerCase(),u=Q('select * from users where email=?').get(e);let id;if(u&&u.banned)return gfail(done);
    if(u){id=u.id;if(!u.verified){Q('update users set verified=1,salt=?,hash=? where id=?').run(rnd(16),rnd(32),id);Q('delete from sessions where uid=?').run(id)}}
    else{const role=c[1]==='z'?'z':'w';id=tx(()=>{const i=Q('insert into users(email,name,role,salt,hash,created,verified) values(?,?,?,?,?,?,1)').run(e,String(g.name||e.split('@')[0]).slice(0,80),role,rnd(16),rnd(32),Date.now()).lastInsertRowid;if(role==='w')credit(i,10,'Punkty startowe','start:'+i);return i})}
    login(s,id);return done(302,'',{Location:'/#/'})}
  return gfail(done)};
const FC=new Map(),file=f=>{const st=fs.statSync(f),c=FC.get(f);if(c&&c.m===st.mtimeMs)return c;const raw=fs.readFileSync(f),r={m:st.mtimeMs,raw,gz:zlib.gzipSync(raw),et:'"'+crypto.createHash('md5').update(raw).digest('hex')+'"'};FC.set(f,r);return r};
const serve=(q,done,f,type,h={})=>{const c=file(f);h={'Content-Type':type,ETag:c.et,'Cache-Control':/\.html$/.test(f)?'no-cache':'public, max-age=3600',Vary:'Accept-Encoding',...h};
  if(q.headers['if-none-match']===c.et)return done(304,'',h);
  if(/gzip/.test(q.headers['accept-encoding']||'')){h['Content-Encoding']='gzip';return done(200,c.gz,h)}return done(200,c.raw,h)};
http.createServer((q,s)=>{const done=(c,body,h={})=>{if(s.cookie)h['Set-Cookie']=s.cookie;s.writeHead(c,{...HDR,...h});s.end(body)};
  const ip=(PROD&&(E.FLY_APP_NAME&&q.headers['fly-client-ip']||q.headers['x-forwarded-for'])||q.socket.remoteAddress||'').split(',')[0].trim();q.ip=ip;
  const url=new URL(q.url,'http://x'),p=decodeURIComponent(url.pathname);
  if(!p.startsWith('/api/')){const sp=seo(p);if(sp)return done(sp.c,sp.b,{'Content-Type':sp.t,...(sp.t==='image/jpeg'?{'Cache-Control':'public, max-age=86400'}:{})});if(p==='/admin')return serve(q,done,path.join(pub,'admin.html'),MIME['.html'],{'X-Robots-Tag':'noindex'});if(p==='/regulamin'||p==='/polityka-prywatnosci')return serve(q,done,path.join(pub,'legal.html'),MIME['.html']);
    const f=path.join(pub,p==='/'?'index.html':p);if(!f.startsWith(pub)||!fs.existsSync(f)||fs.statSync(f).isDirectory())return done(404,'Nie znaleziono');
    return serve(q,done,f,MIME[path.extname(f)]||'application/octet-stream')}
  let raw='';q.on('data',c=>{raw+=c;if(raw.length>(p==='/api/jobs'?700e3:50e3))q.destroy()});q.on('end',async()=>{try{
    if(p.startsWith('/api/auth/google')&&q.method==='GET')return await google(q,s,url,done).catch(()=>gfail(done));
    if(p==='/api/stripe-webhook'&&q.method==='POST')return done(200,JSON.stringify(stripeHook(q,raw)),{'Content-Type':'application/json'});
    for(const[m,re,f]of routes){const x=p.match(re);if(m===q.method&&x){let b={};if(raw)try{b=JSON.parse(raw)}catch(e){throw new Err(400,'Zły JSON')}
      const r=await f(q,s,b,x);return done(200,JSON.stringify(r),{'Content-Type':'application/json'})}}
    throw new Err(404,'Nie znaleziono')}catch(e){if(!(e instanceof Err))console.error(e);done(e.c||500,JSON.stringify({error:e.c?e.message:'Błąd serwera'}),{'Content-Type':'application/json'})}})
}).listen(PORT,()=>console.log('Zlecenka na porcie '+PORT));
setInterval(()=>Q('delete from sessions where exp<?').run(Date.now()),36e5).unref();
setInterval(()=>{const n=Date.now();for(const[k,a]of hits)if(!a.length||a[a.length-1]<n-36e5)hits.delete(k)},6e5).unref();
const bk=()=>{try{const dir=path.join(path.dirname(path.resolve(E.DB_FILE||'zlecenka.db')),'backups'),out=path.join(dir,'zlecenka-'+new Date().toISOString().slice(0,10)+'.db');fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(out))db.exec("vacuum into '"+out.replace(/'/g,"''")+"'");fs.readdirSync(dir).filter(f=>/^zlecenka-.*\.db$/.test(f)).sort().slice(0,-14).forEach(f=>fs.unlinkSync(path.join(dir,f)))}catch(e){console.error('backup',e.message)}};
setTimeout(bk,1e4).unref();setInterval(bk,36e5).unref();
