// Użycie: node backup.js [katalog]. Tworzy spójną kopię bazy i zostawia 14 ostatnich.
const {DatabaseSync}=require('node:sqlite'),path=require('path'),fs=require('fs');
const src=process.env.DB_FILE||'zlecenka.db',dir=process.argv[2]||'backups';fs.mkdirSync(dir,{recursive:true});
const out=path.join(dir,'zlecenka-'+new Date().toISOString().slice(0,10)+'.db');if(fs.existsSync(out))fs.unlinkSync(out);
new DatabaseSync(src).exec("vacuum into '"+out.replace(/'/g,"''")+"'");console.log('Kopia:',out);
fs.readdirSync(dir).filter(f=>/^zlecenka-.*\.db$/.test(f)).sort().slice(0,-14).forEach(f=>fs.unlinkSync(path.join(dir,f)));
