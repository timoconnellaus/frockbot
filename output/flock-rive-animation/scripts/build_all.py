from pathlib import Path
import subprocess,json,sys,xml.etree.ElementTree as E,zipfile
ROOT=Path(__file__).resolve().parents[1]
NAMES=sys.argv[1:] or ['guardian','sunny','chill','nudge','fox','dog','goat','cow','cat','rabbit']
RIVE=str(Path.home()/'.rive/bin/rive')
reports=json.loads((ROOT/'build-report.json').read_text()) if (ROOT/'build-report.json').exists() else {}
for name in NAMES:
 subprocess.run([sys.executable,str(ROOT/'scripts/build_rig.py'),name],check=True,stdout=subprocess.DEVNULL)
 folder=ROOT/'characters'/name;rig=folder/'rig'
 p=subprocess.run([RIVE,str(rig),'--once','--format=json'],capture_output=True,text=True)
 if p.returncode:raise RuntimeError(name+p.stdout+p.stderr)
 inspect=json.loads(subprocess.check_output([RIVE,'inspect',str(rig),'--summary'],text=True))
 assert not inspect['problems'],inspect['problems']
 svg=E.parse(folder/(name+'.svg')).getroot();meta=json.loads((folder/(name+'.json')).read_text())
 parts_dir=folder/'parts';parts_dir.mkdir(exist_ok=True)
 for part in meta['parts']:
  group=next(g for g in svg.findall('{*}g') if g.get('data-part')==part['id'])
  x1,y1,x2,y2=part['bounds'];pad=10
  doc=E.Element('svg',xmlns='http://www.w3.org/2000/svg',viewBox=f'{x1-pad} {y1-pad} {x2-x1+pad*2} {y2-y1+pad*2}')
  # Strip ElementTree namespace prefixes on standalone copies.
  import copy
  clean=copy.deepcopy(group)
  for e in clean.iter():e.tag=e.tag.rsplit('}',1)[-1]
  doc.append(clean)
  (parts_dir/(part['id']+'.svg')).write_text(E.tostring(doc,encoding='unicode')+'\n')
 reports[name]={'parts':len(meta['parts']),'profile':meta['profile'],'problems':inspect['problems'],'bytes':(rig/'build'/(name+'.riv')).stat().st_size}
 print(name,reports[name],flush=True)
(ROOT/'build-report.json').write_text(json.dumps(reports,indent=2)+'\n')
