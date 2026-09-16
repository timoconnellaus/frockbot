"""Package review assets without generated screenshots or tracing intermediates."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
with ZipFile(ROOT/'flock-animated-characters.zip','w',ZIP_DEFLATED) as z:
    for name in ['README.md','build-report.json','verification.json','source.json']:
        p = ROOT/name
        if p.exists():
            z.write(p,name)
    for p in sorted((ROOT/'scripts').iterdir()):
        if p.is_file():
            z.write(p,p.relative_to(ROOT))
    for char in sorted((ROOT/'characters').iterdir()):
        if not char.is_dir():
            continue
        paths = [char/(char.name+'.svg'), char/(char.name+'.json')]
        paths += sorted((char/'parts').glob('*.svg'))
        paths += [char/'rig'/p for p in ['scene.rml','rive.yaml','contract.json',f'build/{char.name}.riv']]
        for p in paths:
            z.write(p,p.relative_to(ROOT))
    pixel = ROOT.parent/'pixel-rive-animation'
    for p in ['scene.rml','rive.yaml','contract.json','build/pixel.riv']:
        z.write(pixel/p,'characters/pixel/rig/'+p)
    z.write(ROOT.parent/'flock-svg-rig/parts/pixel.svg','characters/pixel/pixel.svg')
print(ROOT/'flock-animated-characters.zip')
