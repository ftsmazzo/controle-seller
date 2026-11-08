import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

const root=process.cwd();
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'controle-seller-source-'));
try{
 const archive=path.join(temporary,'source.tgz');
 const included=['app','src','public','scripts','migrations','package.json','package-lock.json','tsconfig.json','next.config.ts','next-env.d.ts'];
 const result=spawnSync('tar',['-czf',archive,...included],{cwd:root,stdio:'inherit'});
 if(result.error||result.status!==0)throw Error('Não foi possível compactar o código. Instale tar e tente novamente.');
 const encoded=(await fs.readFile(archive)).toString('base64');
 const chunks=encoded.match(/.{1,16000}/g)??[];
 const source=['FROM node:22-alpine AS source','WORKDIR /app',...chunks.map((chunk,index)=>`RUN node -e "require('node:fs').${index?'appendFileSync':'writeFileSync'}('/tmp/source.tgz',Buffer.from('${chunk}','base64'))"`),'RUN tar -xzf /tmp/source.tgz -C /app && rm /tmp/source.tgz'].join('\n');
 const dockerfile=`
FROM node:22-alpine AS deps
WORKDIR /app
COPY --from=source /app/package.json /app/package-lock.json ./
RUN npm ci

FROM deps AS build
COPY --from=source /app/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=source --chown=app:app /app/package.json /app/tsconfig.json ./
COPY --from=source --chown=app:app /app/src ./src
COPY --from=source --chown=app:app /app/scripts ./scripts
COPY --from=source --chown=app:app /app/migrations ./migrations
USER app
EXPOSE 3000
CMD ["node","server.js"]
`;
 const destination=path.join(root,'easypanel.inline.Dockerfile');
 await fs.writeFile(destination,source+'\n'+dockerfile);
 console.log('Arquivo inline gerado: '+destination);
}finally{await fs.rm(temporary,{recursive:true,force:true})}
