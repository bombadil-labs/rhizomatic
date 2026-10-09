# Independent Python CBOR construction for SPEC-16 description fields (no witness imports).
import json,struct
from pathlib import Path
def header(m,n):
 return bytes([m*32+n]) if n<24 else bytes([m*32+24,n]) if n<256 else bytes([m*32+25])+struct.pack('>H',n) if n<65536 else bytes([m*32+26])+struct.pack('>I',n)
def c(v):
 if isinstance(v,bool):return bytes([0xf5 if v else 0xf4])
 if isinstance(v,(int,float)):
  for prefix,fmt in [(b'\xf9','>e'),(b'\xfa','>f'),(b'\xfb','>d')]:
   try:
    b=struct.pack(fmt,v)
    if struct.unpack(fmt,b)[0]==v:return prefix+b
   except OverflowError:pass
  raise ValueError(v)
 if isinstance(v,str):
  b=v.encode();return header(3,len(b))+b
 if isinstance(v,bytes):return header(2,len(v))+v
 if isinstance(v,list):return header(4,len(v))+b''.join(c(x) for x in v)
 if isinstance(v,dict):return header(5,len(v))+b''.join(c(k)+c(x) for k,x in sorted(v.items(),key=lambda p:c(p[0])))
 raise ValueError(v)
key='ed25519:'+'01'*32
id=lambda n:'1e20'+('%02x'%n)*32
cases=[]
def add(name,kind,fields,order,verb=None):
 fs={'kind':[kind],**fields}
 pointers=[{'role':'rhizomatic.materialization.'+k,'target':t} for k in order for t in fs.get(k,[])]
 claims={'author':key,'timestamp':1000,'validFrom':1000,'pointers':pointers}
 cases.append({'id':name,'kind':kind,'verb':verb,'claims':claims,'expectedClaimsHex':c(claims).hex(),'expectedRoles':[p['role'] for p in pointers]})
CONTROL=['install','replace-source','advance-time','retire']
for verb in ['gather','resolve','install','replace-source','advance-time','retire','read','restore']:
 add('operation_'+verb,'operation/1',{'name':[{'id':'rhizomatic.materialization.'+verb}],'interpreter':['rhizomatic.materialization.'+verb+'/1'],'input-contract':['rhizomatic.materialization.'+verb+'/1'],'output-contract':['rhizomatic.materialization.outcome/1'],'effect':['control' if verb in CONTROL else 'none'],'replay':['re-evaluate/1'],'dependencies':['explicit-support/1']},['kind','name','interpreter','input-contract','output-contract','effect','replay','dependencies'])
common={'receiver':[{'id':key}],'configuration':[{'delta':id(1)}],'operation':[{'delta':id(2)}]}
add('request_resolve','request/1',{**common,'evidence':[{'delta':id(3)}]},['kind','receiver','configuration','operation','evidence'],'resolve')
# MR-08 lifecycle requests: writer order is common fields, then the verb table's roles.
C=['kind','receiver','configuration','operation']
add('request_install','request/1',{**common,'expected-control':[''],'registration':[{'delta':id(4)}],'capture':[{'delta':id(5)}],'snapshot':[{'delta':id(6)}],'at':[1000],'serving-at':[1000]},C+['expected-control','registration','capture','snapshot','at','serving-at'],'install')
add('request_replace_source','request/1',{**common,'expected-control':[id(7)],'registration':[{'delta':id(4)}],'expected-source':[id(8)],'capture':[{'delta':id(5)}],'snapshot':[{'delta':id(6)}],'serving-at':[1000]},C+['expected-control','registration','expected-source','capture','snapshot','serving-at'],'replace-source')
add('request_advance_time','request/1',{**common,'expected-control':[id(7)],'registration':[{'delta':id(4)}],'expected-source':[id(8)],'snapshot':[{'delta':id(6)}],'at':[1500],'serving-at':[1000]},C+['expected-control','registration','expected-source','snapshot','at','serving-at'],'advance-time')
add('request_retire','request/1',{**common,'expected-control':[id(7)],'registration':[{'delta':id(4)}]},C+['expected-control','registration'],'retire')
add('request_read','request/1',{**common,'expected-control':[id(7)],'registration':[{'delta':id(4)}],'expected-source':[id(8)],'snapshot':[{'delta':id(6)}],'serving-at':[1000]},C+['expected-control','registration','expected-source','snapshot','serving-at'],'read')
add('request_restore','request/1',{**common,'expected-control':['']},C+['expected-control'],'restore')
# MR-13 registration descriptor: roots and aliases sorted by UTF-8, definitions by ID.
add('registration','registration/1',{'source-binding':[{'delta':id(1)}],'hyperschema':[{'delta':id(9)}],'hyperschema-pin':[id(10)],'schema':[{'delta':id(11)}],'schema-pin':[id(12)],'definition':[{'delta':id(13)},{'delta':id(14)}],'roots':[{'id':'item:bed'},{'id':'item:fern'}],'bindings':[{'mime':'application/cbor','value':b'\xa0'}],'definition-at':[1000],'interpretation':['core/1'],'result-kind':['hview-and-view/1'],'time-policy':['live-time/1'],'alias':['Plant']},['kind','source-binding','hyperschema','hyperschema-pin','schema','schema-pin','definition','roots','bindings','definition-at','interpretation','result-kind','time-policy','alias'])
# MR-14 latest transitions: active verbs carry capture; retire carries none.
add('state_install','state/1',{'registration':[{'delta':id(4)}],'generation':[1],'prior-control':[''],'prior-transition':[''],'verb':['install'],'source-revision':[id(8)],'authority':[id(15)],'at':[1000],'definition-at':[1000],'hyperschema-pin':[id(10)],'schema-pin':[id(12)],'capture':[{'delta':id(5)}]},['kind','registration','generation','prior-control','prior-transition','verb','source-revision','authority','at','definition-at','hyperschema-pin','schema-pin','capture'])
add('state_retire','state/1',{'registration':[{'delta':id(4)}],'generation':[2],'prior-control':[id(7)],'prior-transition':[id(16)],'verb':['retire'],'source-revision':[id(8)],'authority':[id(15)],'at':[1000],'definition-at':[1000],'hyperschema-pin':[id(10)],'schema-pin':[id(12)]},['kind','registration','generation','prior-control','prior-transition','verb','source-revision','authority','at','definition-at','hyperschema-pin','schema-pin'])
add('control_image','control-image/1',{'data':[{'mime':'application/cbor','value':b'\xa0'}]},['kind','data'])
# Byte target fixture encoded separately for canonical bytes, JSON debug represents base64url.
add('authority','authority/1',{'source-binding':[{'delta':id(1)}],'spec':[{'mime':'application/cbor','value':b'\xa0'}]},['kind','source-binding','spec'])
import base64
for a in cases:
 for p in a['claims']['pointers']:
  t=p['target']
  if isinstance(t,dict) and isinstance(t.get('value'),bytes):t['value']=base64.urlsafe_b64encode(t['value']).decode().rstrip('=')
negatives=[{'id':'unknown_role','base':'request_resolve','mutation':'extra-role'},{'id':'install_extra_role','base':'request_install','mutation':'extra-role'},{'id':'retire_duplicate_receiver','base':'request_retire','mutation':'duplicate-receiver'},{'id':'registration_extra_role','base':'registration','mutation':'extra-role'},{'id':'state_extra_role','base':'state_retire','mutation':'extra-role'},{'id':'control_image_extra_role','base':'control_image','mutation':'extra-role'},{'id':'duplicate_singleton','base':'request_resolve','mutation':'duplicate-receiver'},{'id':'contextual_reference','base':'request_resolve','mutation':'reference-context'},{'id':'unknown_operation','base':'operation_gather','mutation':'unknown-name'},{'id':'wrong_mime','base':'authority','mutation':'wrong-mime'}]
Path('vectors/materialization/command-descriptions.json').write_text(json.dumps({'format':'rhizomatic-materialization-description-vectors/1','oracle':'SPEC-16 role tables and independent Python RFC8949 major types/preferred float16/32/64; map ordering by complete encoded keys. No witness codec or hash imports. Claims hex excludes detached signature.','positives':cases,'negatives':negatives},indent=2)+'\n')
