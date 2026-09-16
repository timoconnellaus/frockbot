"""The approved eyes-only terrier: complete hand-drawn, smoothly curved anatomy."""
from pathlib import Path
import json, hashlib, xml.etree.ElementTree as E
from PIL import Image
from prepare_art import P, expand, transform, svgpath, capsule, boolean, pathops

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent/'flock-svg-style-cards/dog-explorations/02-eyes-only.png'
CROP = [750,650,1140,1178]
DEST = ROOT/'characters/dog'
INK='#232724'; TAN='#dca258'; CREAM='#fff1d3'; PINK='#e8a382'
S=580/528
T=(S,0,0,S,(457-390*S)/2,18)
svg=E.Element('svg',xmlns='http://www.w3.org/2000/svg',width='457',height='615',viewBox='0 0 457 615')
E.SubElement(svg,'title').text='Dog — one ear up, complete animation anatomy'
meta={'name':'dog','width':457,'height':615,'profile':'seated-terrier','sourceImage':str(SOURCE.relative_to(ROOT.parent.parent)),
      'sourceCrop':CROP,'conceptSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
      'palette':{'primary':TAN,'shade':'#b67c39','eyeColor':CREAM},'parts':[]}
current=None; current_shapes=[]

def paint(d, color, role=None, stroke=0):
    shape=P(d) if isinstance(d,str) else d
    if stroke:
        shape.stroke(stroke,pathops.LineCap.ROUND_CAP,pathops.LineJoin.ROUND_JOIN,4)
        shape.convertConicsToQuads(.02)
    a={'fill':color,'d':svgpath(transform(shape,T))}
    if role:a['data-color-role']=role
    E.SubElement(current,'path',**a)
    current_shapes.append(transform(shape,T))

def part(name,pivot,d,color=TAN,outline=True):
    global current,current_shapes
    current_shapes=[]
    px,py=pivot;px=px*S+T[4];py=py*S+T[5]
    current=E.SubElement(svg,'g',id='dog-'+name,**{'data-part':name,'data-pivot':f'{px:.4f} {py:.4f}'})
    meta['parts'].append({'id':name,'pivot':[px,py],'layer':len(meta['parts']),'hasCompletion':True})
    if outline:paint(expand(P(d),3.1),INK)
    paint(d,color,'primary' if color==TAN else None)

def finish():
    bounds=[p.bounds for p in current_shapes]
    meta['parts'][-1]['bounds']=[min(p[0] for p in bounds),min(p[1] for p in bounds),max(p[2] for p in bounds),max(p[3] for p in bounds)]

part('tail',(273,427),'M260 397C289 384 304 347 307 309C307 296 309 291 314 297C338 319 343 355 334 389C329 411 315 435 292 455L264 444Z')
paint('M307 309C307 296 309 291 314 297C328 311 336 330 337 349L324 362L316 349L306 355Q311 333 307 309Z',CREAM)
finish()
part('haunch-left',(79,442),'M80 388C56 384 36 405 31 428C25 450 35 466 47 474C29 478 26 496 38 502C49 511 78 510 101 498L111 459Z')
paint('M43 470Q66 459 94 480L101 498C78 510 49 511 38 502C26 496 29 478 47 474Z',CREAM)
paint('M57 481Q48 490 55 501M76 484Q69 492 76 503',INK,stroke=3.2)
finish()
part('haunch-right',(258,443),'M255 387C275 385 293 403 300 425C308 448 295 468 287 475C303 481 307 494 295 503C281 512 247 508 226 497L216 452Z')
paint('M238 478Q261 458 287 475C303 481 307 494 295 503C281 512 247 508 226 497Z',CREAM)
paint('M260 481Q270 489 269 502M242 485Q249 491 249 501',INK,stroke=3.2)
finish()
part('fur',(168,415),'M113 264C99 280 86 302 76 326L63 351L74 345C65 368 66 384 76 402L80 389L99 475Q121 489 155 488L178 488Q205 487 227 473L247 376L246 404L272 393C264 349 248 308 225 281L209 264Z')
paint('M118 268Q169 280 208 267C210 289 218 317 217 333L208 327C212 345 207 362 203 364L199 357C198 378 187 401 180 414L173 486L157 486L145 420C137 407 126 395 117 370L113 375C105 365 103 346 105 333L99 339C94 325 105 288 118 268Z',CREAM)
finish()
# Forelegs have complete hidden roots; only their exposed outlines are inked.
# No horizontal cut line crosses a leg at its attachment to the torso.
part('foot-left',(112,420),'M80 380L106 360Q111 377 129 390Q137 405 142 416L153 481C158 504 143 519 122 520C100 521 86 518 83 507C80 495 85 483 98 473L80 399Z',outline=False)
paint('M88 436Q111 416 143 435L153 481C158 504 143 519 122 520C100 521 86 518 83 507C80 495 85 483 98 473Z',CREAM)
paint('M80 399L98 473C85 483 80 495 83 507C86 518 100 521 122 520C143 519 158 504 153 481L142 416Q136 400 129 390M104 489Q94 503 102 513M125 490Q119 505 125 516',INK,stroke=3.2)
finish()
part('foot-right',(211,420),'M197 378Q205 365 208 346Q229 350 239 353L246 376L227 473C240 480 247 490 243 504C240 518 224 522 203 520C180 518 170 508 173 489L180 418Q183 396 197 378Z',outline=False)
paint('M179 439Q204 416 235 432L227 473C240 480 247 490 243 504C240 518 224 522 203 520C180 518 170 508 173 489Z',CREAM)
paint('M246 376L227 473C240 480 247 490 243 504C240 518 224 522 203 520C180 518 170 508 173 489L180 418Q183 396 196 378M196 490Q200 503 195 514M215 489Q224 503 215 517',INK,stroke=3.2)
finish()
part('ear-right',(220,125),'M186 110C194 76 218 32 250 14C263 5 269 9 273 21C284 48 285 83 278 111C274 133 262 151 249 165L216 160Z')
paint('M209 105C215 77 231 49 250 34C256 28 260 29 263 39C269 61 270 89 265 112Q262 126 252 140C245 125 229 112 209 105Z',PINK)
paint('M209 105C215 77 231 49 250 34M209 105Q238 115 252 140',INK,stroke=4)
finish()
part('head',(170,268),'M72 128C81 106 100 96 124 95C148 88 174 89 193 96L215 101C241 110 254 134 255 160C258 177 261 190 271 202L262 199L267 224L256 218C253 241 235 261 213 277C184 287 144 289 109 280C86 272 72 260 66 244L60 252Q56 244 62 226L52 230L60 212C69 191 65 164 72 128Z')
paint('M143 94Q160 89 180 94L172 148L148 149Z',CREAM)
paint('M107 252Q161 265 211 254L224 271Q179 295 109 280L96 273Z',CREAM)
paint('M111 275Q159 287 211 276L214 284Q166 297 106 283Z',CREAM)
paint('M147 145C171 142 195 146 214 158C233 170 240 186 240 208C240 234 230 250 209 260C188 268 139 267 117 259C96 250 82 232 82 211C79 190 88 169 106 157C118 149 132 147 147 145Z',INK)
finish()
part('ear-left',(92,112),'M122 97C111 87 108 78 92 80C75 81 45 94 26 107C15 114 14 123 19 140C24 161 33 178 43 182C55 187 69 174 75 160C83 141 89 119 98 106L104 105Z')
finish()
for side,cx in [('left',126),('right',194)]:
    part('eye-'+side,(cx,205),svgpath(capsule(cx,205,20,64)),CREAM,outline=False)
    list(current)[0].set('data-color-role','eyeColor')
    finish()

DEST.mkdir(parents=True,exist_ok=True)
E.indent(svg,space='  ')
(DEST/'dog.svg').write_text(E.tostring(svg,encoding='unicode')+'\n')
(DEST/'dog.json').write_text(json.dumps(meta,indent=2)+'\n')
Image.open(SOURCE).crop(CROP).save(ROOT/'assets/dog-concept.png')
sources=json.loads((ROOT/'source.json').read_text())
sources['crops'].pop('dog',None)
sources.setdefault('overrides',{})['dog']={'source':str(SOURCE.relative_to(ROOT.parent.parent)),'sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'crop':CROP,'choice':'D — one ear up, eyes-only face'}
(ROOT/'source.json').write_text(json.dumps(sources,indent=2)+'\n')
print('dog: 11 complete parts, selected one-ear-up concept')
