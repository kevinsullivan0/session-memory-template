import { build } from 'esbuild';
import { mkdir,copyFile } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['app/main.tsx'],bundle:true,outfile:'dist/app.js',format:'esm',jsx:'automatic',minify:true,legalComments:'linked'});
await Promise.all(['index.html','style.css'].map(name=>copyFile(`app/${name}`,`dist/${name}`)));
console.log('Built local web app.');
