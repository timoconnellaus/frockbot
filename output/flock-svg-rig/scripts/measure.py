"""Fixed, foreground-only likeness metrics; no registration, blur or background credit."""
from pathlib import Path
import json,sys,hashlib,xml.etree.ElementTree as ET
import numpy as np
from PIL import Image,ImageFilter
ROOT=Path(__file__).resolve().parents[1]

def box(a,r=5):
    p=np.pad(a,((r,r),(r,r)),mode='reflect')
    s=np.pad(p,((1,0),(1,0))).cumsum(0).cumsum(1);k=2*r+1
    return (s[k:,k:]-s[:-k,k:]-s[k:,:-k]+s[:-k,:-k])/(k*k)

def dilate(a,r=1):return np.asarray(Image.fromarray((a*255).astype('uint8')).filter(ImageFilter.MaxFilter(2*r+1)))>0

def edge(a):
    # Fixed threshold on RGB gradient: includes pink/yellow boundaries, not just luminance.
    p=np.pad(a,((1,1),(1,1),(0,0)),mode='edge')
    dx=(p[:-2,2:]+2*p[1:-1,2:]+p[2:,2:]-p[:-2,:-2]-2*p[1:-1,:-2]-p[2:,:-2])/4
    dy=(p[2:,:-2]+2*p[2:,1:-1]+p[2:,2:]-p[:-2,:-2]-2*p[:-2,1:-1]-p[:-2,2:])/4
    return np.sqrt(dx*dx+dy*dy).max(2)>40

def metrics(name,version):
    ref=np.asarray(Image.open(ROOT/'assets'/f'{name}-reference.png').convert('RGB'),dtype=float)
    mask=np.asarray(Image.open(ROOT/'assets'/f'{name}-mask.png'))>0
    folder=ROOT/'versions'/version;svg=folder/f'{name}.svg';rgba=np.asarray(Image.open(folder/f'{name}-render.png').convert('RGBA'),dtype=float)
    alpha=rgba[:,:,3:4]/255
    # Same constant presentation background on both sides outside the fixed mask.
    bg=np.array([255.,249.,239.]);reference=np.where(mask[:,:,None],ref,bg)
    render=rgba[:,:,:3]*alpha+bg*(1-alpha)
    candidate=alpha[:,:,0]>=.5;domain=mask|candidate
    color=100*(1-np.abs(reference-render)[domain].mean()/255)
    channels=[]
    for i in range(3):
        x=reference[:,:,i];y=render[:,:,i];mx=box(x);my=box(y)
        vx=np.maximum(0,box(x*x)-mx*mx);vy=np.maximum(0,box(y*y)-my*my);cov=box(x*y)-mx*my
        c1=(.01*255)**2;c2=(.03*255)**2
        local=((2*mx*my+c1)*(2*cov+c2))/((mx*mx+my*my+c1)*(vx+vy+c2))
        channels.append(local[domain].mean())
    ssim=max(0,min(100,float(np.mean(channels))*100))
    area=dilate(domain);a=edge(reference)&area;b=edge(render)&area
    precision=np.count_nonzero(b&dilate(a))/max(1,b.sum());recall=np.count_nonzero(a&dilate(b))/max(1,a.sum())
    f1=100*2*precision*recall/max(1e-10,precision+recall)
    iou=100*np.count_nonzero(mask&candidate)/max(1,np.count_nonzero(domain))
    diff=np.abs(reference-render)*6;diff[~dilate(domain)]=0
    Image.fromarray(np.clip(diff,0,255).astype('uint8')).save(folder/f'{name}-diff.png')
    # The displayed evaluation reference is exactly the image used by the metric.
    Image.fromarray(reference.astype('uint8')).save(ROOT/'assets'/f'{name}-evaluation.png')
    tree=ET.parse(svg);paths=sum(e.tag.endswith('}path') for e in tree.iter())
    result={'name':name,'color':color,'ssim':ssim,'edge':f1,'silhouette':iou,'score':min(color,ssim,f1),'paths':paths,'bytes':svg.stat().st_size,'svg':str(svg.relative_to(ROOT)),'diff':str((folder/f'{name}-diff.png').relative_to(ROOT)),'sha256':hashlib.sha256(svg.read_bytes()).hexdigest()}
    return result

if __name__=='__main__':
    version=sys.argv[1];label=sys.argv[2] if len(sys.argv)>2 else version
    source=json.loads((ROOT/'source.json').read_text())
    if hashlib.sha256((ROOT/source['source']).read_bytes()).hexdigest()!=source['sha256']:raise RuntimeError('Locked reference changed')
    chars=[metrics(n,version) for n in ['guardian','pixel','sunny']]
    record={'id':version,'label':label,'characters':chars}
    (ROOT/'versions'/version/'metrics.json').write_text(json.dumps(record,indent=2))
    report=json.loads((ROOT/'report.json').read_text());report['versions']=[v for v in report['versions'] if v['id']!=version]+[record]
    report['status']='All sheep pass the fixed >95% target.' if all(c['score']>95 for c in chars) else 'Measured revision ready. Refining the remaining differences.'
    tmp=ROOT/'report.tmp';tmp.write_text(json.dumps(report,indent=2));tmp.replace(ROOT/'report.json')
    for c in chars:print(c['name'],{k:round(c[k],3) for k in ['score','color','ssim','edge','silhouette']},'bytes',c['bytes'],flush=True)
