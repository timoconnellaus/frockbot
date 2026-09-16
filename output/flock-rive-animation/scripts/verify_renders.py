"""Render real Rive state combinations and compare the resting SVG assemblies."""
from pathlib import Path
import json, sys, hashlib
import subprocess
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RIVE = Path.home() / '.rive/bin/rive'
NAMES = sys.argv[1:] or 'guardian sunny chill nudge fox dog goat cow cat rabbit'.split()
report = json.loads((ROOT/'verification.json').read_text())['characters'] if (ROOT/'verification.json').exists() else {}
for name in NAMES:
    char = ROOT / 'characters' / name
    out = char / 'rig/build/verification'
    out.mkdir(parents=True, exist_ok=True)

    def capture(label, frames=100, **data):
        cmd = [str(RIVE), str(char/'rig'), f'--screenshot={out/label}.png', f'--advance={frames}']
        cmd += [f'--data={k}={str(v).lower() if isinstance(v,bool) else v}' for k,v in data.items()]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(p.stdout+p.stderr)
        a = np.array(Image.open(out/(label+'.png')).convert('RGB'))
        assert a.shape == (760, 640, 3), a.shape
        assert np.count_nonzero(np.max(a,axis=2)>80)>10000, label
        return a

    def changed(a,b):
        return int(np.count_nonzero(np.any(a!=b,axis=2)))

    neutral = capture('neutral', reducedMotion=True)
    source = Image.open(char/(name+'.png')).convert('RGBA')
    assert source.size == (457,615), source.size
    bg = Image.new('RGBA',source.size,(29,29,29,255))
    bg.alpha_composite(source)
    ref = np.array(bg.convert('RGB')).astype(float)
    actual = neutral[100:715,92:549].astype(float)
    mask = np.array(source)[:,:,3]>0
    agreement = 100*(1-np.abs(actual-ref)[mask].mean()/255)
    result = {'restingSvgRgbAgreement': round(agreement,4), 'sourceSvgSha256':hashlib.sha256((char/(name+'.svg')).read_bytes()).hexdigest()}
    sheet = Image.new('RGB',(8*160,4*208),(245,242,237))
    draw = ImageDraw.Draw(sheet)
    for activity in range(4):
        for emotion in range(8):
            a = capture(f'activity-{activity}-emotion-{emotion}',activity=activity,emotion=emotion)
            sheet.paste(Image.fromarray(a).resize((160,190)),(emotion*160,activity*208))
            draw.text((emotion*160+5,activity*208+192),f'Activity {activity} / Feeling {emotion}',fill=(40,40,40))
    sheet.save(out/'contact-sheet.png')
    result['combinationsRendered'] = 32
    result['idleChangedPixels'] = changed(capture('idle-a',frames=1),capture('idle-b',frames=120))
    result['gazeChangedPixels'] = changed(capture('gaze-left',activity=5,lookX=-1),capture('gaze-right',activity=5,lookX=1))
    result['hoverChangedPixels'] = changed(capture('hover',frames=12,activity=5,hovered=True),capture('no-hover',frames=12,activity=5))
    result['paletteChangedPixels'] = changed(neutral,capture('palette',reducedMotion=True,primary='FF87D5B6'))
    result['stillModeIdenticalFrames'] = bool(np.array_equal(neutral,capture('still-later',frames=240,reducedMotion=True)))
    result['successChangedPixels'] = changed(neutral,capture('success',frames=33,activity=4,emotion=1))
    result['passed'] = bool(agreement>98 and result['stillModeIdenticalFrames'] and all(result[k]>100 for k in ['idleChangedPixels','gazeChangedPixels','hoverChangedPixels','paletteChangedPixels','successChangedPixels']))
    report[name] = result
    (ROOT/'verification.json').write_text(json.dumps({'scope':'Native Rive rendering. Agreement measures converted Rive against the separated SVG, not likeness to concept art. Flutter device integration has not been tested.','characters':report},indent=2)+'\n')
    print(name,json.dumps(result),flush=True)
assert all(r['passed'] for r in report.values()), 'See verification.json for failed checks'
