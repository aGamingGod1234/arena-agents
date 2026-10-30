// Private provider audits flatten newlines. Read complete JSON packets without exporting their text.
export function* capturedFactPackets(input) {
 if(typeof input!=='string')return;
 let inputs=[input];
 try{const packed=JSON.parse(input);if(Array.isArray(packed)&&packed.every(v=>typeof v?.input==='string'))inputs=packed.map(v=>v.input);}catch{}
 for(const text of inputs){
  const markers=/\{"(?:format|observation|event)":/g;let match;
  while((match=markers.exec(text))){
   let depth=0,quoted=false,escaped=false,end=-1;
   for(let i=match.index;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){end=i+1;break;}
   }
   if(end<0)break;markers.lastIndex=end;
   try{yield JSON.parse(text.slice(match.index,end));}catch{}
  }
 }
}
