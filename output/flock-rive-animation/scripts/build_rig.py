"""Build each mascot with a shared control contract and species-specific motion."""
from pathlib import Path
import sys, math, json, hashlib, xml.etree.ElementTree as E
sys.path.insert(0, '/private/tmp/flock-parts-deps')
from fontTools.pens.basePen import BasePen
from fontTools.svgLib.path import parse_path

CAST = Path(__file__).resolve().parents[1]
NAME = sys.argv[1]
TITLE = NAME.title()
ROOT = CAST / 'characters' / NAME / 'rig'
ROOT.mkdir(parents=True,exist_ok=True)
SOURCE = ROOT.parent / (NAME+'.svg')
NS = {'s': 'http://www.w3.org/2000/svg'}
svg = E.parse(SOURCE).getroot()
manifest = json.loads(SOURCE.with_suffix('.json').read_text())
parts = {p['id']: p for p in manifest['parts']}
PROFILE = manifest['profile']
COLORS = manifest['palette']
groups = {e.get('data-part'): e for e in svg.findall('.//s:g', NS)}
doc = E.Element('Rive', version='1', kind='fragment')
serial = 100
ids = {}
def add(parent, tag, **attrs):
    return E.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
def ident(name):
    global serial
    if name not in ids:
        serial += 1
        ids[name] = f'0:{serial}'
    return ids[name]
def node(parent, name, **attrs):
    return add(parent, 'Node', name=name, id=ident(name), **attrs)

vm = add(doc, 'ViewModel', name=TITLE, id='0:40', defaultInstanceId='0:41')
defaults = {'activity': ('Number', 0), 'emotion': ('Number', 0),
    'hovered': ('Boolean', 'false'), 'lookX': ('Number', 0), 'lookY': ('Number', 0),
    'primary': ('Color', 'FF'+COLORS['primary'][1:].upper()), 'shade': ('Color', 'FF'+COLORS['shade'][1:].upper()),
    'eyeColor': ('Color', 'FF'+COLORS['eyeColor'][1:].upper()), 'reducedMotion': ('Boolean', 'false')}
for name, (kind, value) in defaults.items():
    add(vm, 'ViewModelProperty'+kind, name=name, id=ident('vm-'+name))
instance = add(vm, 'ViewModelInstance', name='Default', id='0:41', exports='true')
for name, (kind, value) in defaults.items():
    add(instance, 'ViewModelInstance'+kind, propertyValue=value, viewModelPropertyId=ident('vm-'+name))
def bind(parent, name, key, converter=None):
    attrs = dict(sourcePathIds='0:40-'+ident('vm-'+name), propertyKey=key)
    if converter: attrs['converterId'] = ident(converter)
    add(parent, 'DataBindContext', **attrs)
for axis, span in [('X', 13), ('Y', 10)]:
    add(doc, 'DataConverterRangeMapper', name='Gaze'+axis, id=ident('gaze-'+axis),
        minInput=-1, maxInput=1, minOutput=-span, maxOutput=span,
        clampLower='true', clampUpper='true')

board = add(doc, 'Artboard', name=TITLE, id='0:2', width=640, height=760,
    defaultStateMachineId='0:7', viewModelId='0:40', viewModelInstanceId='0:41', styleId='0:5')
add(board, 'LayoutComponentStyle', id='0:5', name='Artboard Style')

class Curves(BasePen):
    def __init__(self):
        super().__init__(None); self.contours=[]; self.current=[]
    def _moveTo(self, p): self.current=[{'p':p}]
    def _lineTo(self, p): self.current.append({'p':p})
    def _curveToOne(self, a,b,p):
        self.current[-1]['out']=a
        self.current.append({'p':p, 'in':b})
    def _qCurveToOne(self, a,p):
        s=self.current[-1]['p']
        self._curveToOne(tuple(s[i]+2*(a[i]-s[i])/3 for i in (0,1)),
                         tuple(p[i]+2*(a[i]-p[i])/3 for i in (0,1)), p)
    def _closePath(self):
        if self.current[-1]['p']==self.current[0]['p']:
            last=self.current.pop()
            if 'in' in last: self.current[0]['in']=last['in']
        self.contours.append((self.current, True)); self.current=[]
    def _endPath(self):
        self.contours.append((self.current, False)); self.current=[]

def path_shape(parent, d, fill, pivot=(0,0), name='Path', stroke=False, role=None):
    shape=add(parent, 'Shape', name=name)
    pen=Curves(); parse_path(d,pen)
    for verts, closed in pen.contours:
        path=add(shape, 'PointsPath', isClosed=str(closed).lower())
        for v in verts:
            x,y=v['p']; attrs={'x':round(x-pivot[0],6),'y':round(y-pivot[1],6)}
            if 'in' in v or 'out' in v:
                for key in ('in','out'):
                    p=v.get(key,(x,y)); dx,dy=p[0]-x,p[1]-y
                    attrs[key+'Rotation']=round(math.atan2(dy,dx),9)
                    attrs[key+'Distance']=round(math.hypot(dx,dy),6)
                add(path,'CubicDetachedVertex',**attrs)
            else: add(path,'StraightVertex',**attrs)
    paint=add(shape,'Stroke' if stroke else 'Fill', **({'thickness':8,'cap':'round','join':'round'} if stroke else {'fillRule':'nonZero'}))
    color=add(paint,'SolidColor',colorValue='FF'+fill.lstrip('#').upper())
    role=role if role is not None else {'#fcf6e3':'eyeColor'}.get(fill)
    if role: bind(color,role,37)
    return shape

# Rive paints sibling shapes front to back; SVG paints them back to front.
root=node(board,'character',x=320.5,y=698)
hover=node(root,'hover-body')
action=node(hover,'activity-body',y=-108)
upper=node(action,'upper-body')
mood=node(upper,'emotion-body')
head_pivot=parts.get('head',{}).get('pivot',[228.5,490])
head=node(mood,'head-motion',x=head_pivot[0]-228.5,y=head_pivot[1]-490) if 'head' in parts else mood
head_origin=head_pivot if 'head' in parts else [228.5,490]
gaze=node(head,'gaze')
bind(gaze,'lookX',13,'gaze-X');bind(gaze,'lookY',14,'gaze-Y')
glance=node(gaze,'ambient-glance')
for side in ('left','right'):
    part='eye-'+side;px,py=parts[part]['pivot']
    eye=node(glance,part,x=px-head_origin[0],y=py-head_origin[1])
    expression=node(eye,part+'-expression')
    blink=node(expression,part+'-blink')
    smile=node(blink,part+'-smile',opacity=0)
    path_shape(smile,'M-11 4 C-9 -12 9 -12 11 4','#fcf6e3',name='Happy eye',stroke=True)
    open_eye=node(blink,part+'-open')
    for i,path in enumerate(reversed(list(groups[part]))):
        if path.tag.endswith('path'):path_shape(open_eye,path.get('d'),path.get('fill'),(px,py),part+' contour '+str(i),role=path.get('data-color-role',''))

nodes={}
def make_part(part,parent,origin):
    px,py=parts[part]['pivot']
    if part.startswith('ear-'):
        anchor=node(parent,part+'-anchor',x=px-origin[0],y=py-origin[1])
        hov=node(anchor,part+'-hover');emotional=node(hov,part+'-emotion');container=node(emotional,part)
        nodes[part]=anchor
    else:
        container=node(parent,part,x=px-origin[0],y=py-origin[1]);nodes[part]=container
    for i,path in enumerate(reversed(list(groups[part]))):
        if path.tag.endswith('path'):path_shape(container,path.get('d'),path.get('fill'),(px,py),part+' contour '+str(i),role=path.get('data-color-role',''))
    return container

head_parts={'head','ear-left','ear-right','whiskers'} if 'head' in parts else set()
order=list(parts)
for part in reversed(order):
    if part.startswith('eye-') or part=='tail-tip':continue
    if part in head_parts:make_part(part,head,head_origin)
    elif part.startswith('foot-'):
        make_part(part,action,[228.5,490])
    else:
        container=make_part(part,mood,[228.5,490])
        if part=='tail' and 'tail-tip' in parts:
            make_part('tail-tip',container,parts['tail']['pivot'])
# Fox forepaws sit in front of the torso; rear paws remain behind it.
for part in ('foot-left','foot-right'):
    if part in parts and order.index(part)>order.index('fur'):
        action.remove(nodes[part]);action.insert(0,nodes[part])

# Shadows are separate from the character so a hop leaves its contact point behind.
shadow=add(board,'Shape',name='Ground shadow',id=ident('shadow'),x=320,y=700)
add(shadow,'Ellipse',width=230,height=20)
paint=add(shadow,'Fill'); add(paint,'SolidColor',colorValue='14151416')

KEY={'x':13,'y':14,'r':15,'sx':16,'sy':17,'o':18}
def timeline(name,duration,tracks,loop=True):
    tracks=profile_tracks(name,duration,tracks)
    anim=add(board,'LinearAnimation',id=ident('anim-'+name),name=name,fps=60,duration=duration,loopValue='loop' if loop else 'oneShot')
    objects={}
    for (target, prop),values in tracks.items():
        if target not in ids: continue
        if target not in objects: objects[target]=add(anim,'KeyedObject',objectId=ident(target))
        keyed=add(objects[target],'KeyedProperty',propertyKey=KEY[prop])
        if isinstance(values,(int,float)): values=[(0,values),(duration,values)]
        for f,v in values:
            k=add(keyed,'KeyFrameDouble',frame=f,value=round(v,6),interpolationType='cubic')
            add(k,'CubicEaseInterpolator',x1=.42,y1=0,x2=.58,y2=1)
    return ident('anim-'+name)
def cycle(values,duration): return [(round(i*duration/(len(values)-1)),v) for i,v in enumerate(values)]
def base_action():
    return {('activity-body','y'):-108,('activity-body','r'):0,('activity-body','sx'):1,('activity-body','sy'):1,
        ('upper-body','y'):0,('upper-body','r'):0,('upper-body','sx'):1,('upper-body','sy'):1,
        ('ear-left','r'):0,('ear-right','r'):0,('foot-left','r'):0,('foot-right','r'):0,
        ('foot-left','y'):-15,('foot-right','y'):-15,('ambient-glance','x'):0,('ambient-glance','y'):0,
        ('shadow','sx'):1,('shadow','o'):1}
def profile_tracks(name,duration,tracks):
    t=dict(tracks)
    # Foot pivots come from the actual anatomy, not Pixel's buried leg height.
    for side in ('left','right'):
        key=('foot-'+side,'y')
        if key in t:
            delta=parts['foot-'+side]['pivot'][1]-475
            v=t[key];t[key]=v+delta if isinstance(v,(int,float)) else [(f,n+delta) for f,n in v]
    seated=PROFILE.startswith('seated')
    standing=PROFILE.startswith('standing')
    gain=.42 if PROFILE in ('grounded','standing-heavy') else .65 if standing or seated else 1
    def damp(key,base=0,amount=gain):
        if key in t:
            v=t[key];t[key]=base+(v-base)*amount if isinstance(v,(int,float)) else [(f,base+(n-base)*amount) for f,n in v]
    for target in ('upper-body','emotion-body','hover-body'):
        damp((target,'r'));damp((target,'sy'),1);damp((target,'sx'),1)
    for target in ('ear-left','ear-right','ear-left-emotion','ear-right-emotion','ear-left-hover','ear-right-hover'):
        ear_gain=(1.05 if target.startswith('ear-left') else .5) if NAME=='dog' else .55 if NAME=='rabbit' else gain
        damp((target,'r'),amount=ear_gain)
    if name in globals().get('activity_names', []):
        if 'head' in parts:t[('head-motion','r')]=0
        if 'tail' in parts:t[('tail','r')]=0
        if 'tail-tip' in parts:t[('tail-tip','r')]=0
    if name=='Idle':
        if NAME=='chill':
            t[('upper-body','r')]=cycle([0,.015,0,-.015,0],duration)
            t[('upper-body','sx')]=cycle([1,1.012,1,.99,1],duration)
        if NAME=='nudge':t[('upper-body','sy')]=cycle([1,1.018,1,1.018,1],duration)
        if 'tail' in parts:
            a={'cat':.09,'fox':.065,'cow':.05,'goat':.06}.get(NAME,.05)
            t[('tail','r')]=cycle([0,a,0,-a*.5,0],duration)
        if 'tail-tip' in parts:t[('tail-tip','r')]=cycle([0,-.09,.035,0,0],duration)
        if NAME=='rabbit':
            t[('foot-right','r')]=[(0,0),(252,0),(261,-.11),(269,0),(278,-.075),(286,0),(duration,0)]
            t[('ear-left','r')]=[(0,0),(111,0),(120,-.07),(135,.025),(150,0),(duration,0)]
        if NAME=='dog':
            t[('ear-left','r')]=[(0,0),(120,0),(135,.055),(159,-.015),(181,0),(duration,0)]
            t[('ear-right','r')]=[(0,0),(104,0),(112,-.055),(123,.018),(137,0),(duration,0)]
            t[('head-motion','r')]=cycle([0,-.016,0,.01,0],duration)
            t[('tail','r')]=[(0,0),(188,0),(205,.085),(224,-.055),(243,.065),(264,0),(duration,0)]
        if NAME=='cat':t[('head-motion','r')]=cycle([0,-.018,0,0,0],duration)
    if name=='Thinking':
        if 'head' in parts:
            t[('head-motion','r')]=cycle([0,-.05,-.05,.015,0],duration)
            damp(('upper-body','r'),amount=.3)
        if 'tail' in parts:t[('tail','r')]=cycle([0,-.03,-.03,.04,0],duration)
        if NAME=='rabbit':t[('ear-right','r')]=cycle([0,.10,.10,.02,0],duration)
    if name=='Working':
        if standing or seated:
            damp(('upper-body','y'),amount=.4)
            t[('foot-left','r')]=0;t[('foot-right','r')]=0
        if NAME=='rabbit':t[('foot-right','r')]=[(0,0),(42,0),(50,-.12),(58,0),(66,-.09),(74,0),(156,0),(164,-.12),(172,0),(duration,0)]
        if NAME=='fox':t[('foot-left','r')]=[(0,0),(110,0),(121,.035),(132,0),(duration,0)]
        if NAME=='goat':t[('head-motion','r')]=cycle([0,.018,0,.018,0],duration)
        if 'tail' in parts:t[('tail','r')]=cycle([0,.04,0,.04,0],duration)
    if name=='Needs attention':
        if 'head' in parts:t[('head-motion','r')]=cycle([0,.055,.055,0,0],duration)
        if NAME=='rabbit':t[('ear-left','r')]=cycle([0,.12,.12,0,0],duration)
        if 'tail' in parts:t[('tail','r')]=cycle([0,-.08,-.08,0,0],duration)
    if name=='Success':
        hop=0 if seated or standing else .4 if PROFILE=='grounded' else 1
        damp(('activity-body','y'),-108,hop)
        damp(('shadow','sx'),1,hop);damp(('shadow','o'),1,hop)
        if seated or standing:
            t[('foot-left','r')]=0;t[('foot-right','r')]=0
            if 'head' in parts:t[('head-motion','r')]=[(0,0),(20,-.04),(42,.03),(68,0),(duration,0)]
        if NAME=='rabbit':
            t[('foot-left','r')]=[(0,0),(18,.14),(30,0),(42,.10),(54,0),(duration,0)]
            t[('foot-right','r')]=[(0,0),(32,-.14),(44,0),(56,-.10),(68,0),(duration,0)]
        if 'tail' in parts:t[('tail','r')]=[(0,0),(15,.15),(30,-.1),(45,.1),(60,-.06),(80,0),(duration,0)]
    if name=='Hover hello':
        if NAME in ('chill','nudge'):t[('hover-body','r')]=[(0,0),(10,-.022),(23,.012),(42,0),(duration,0)]
        if NAME=='dog':
            t[('ear-right-hover','r')]=[(0,0),(7,-.075),(17,.02),(30,0),(duration,0)]
            t[('ear-left-hover','r')]=[(0,0),(7,0),(16,.105),(29,-.025),(44,0),(duration,0)]
    if name in ('Still','Reduced pose'):
        if 'head' in parts:t[('head-motion','r')]=0
        if 'tail' in parts:t[('tail','r')]=0
        if 'tail-tip' in parts:t[('tail-tip','r')]=0
    return t

activity_names=['Idle','Thinking','Working','Needs attention','Success','Still']
for i,name in enumerate(activity_names):
    d=[480,300,240,360,150,60][i]; t=base_action()
    if i==0:
        t[('upper-body','sy')]=cycle([1,1.012,1,1.012,1],d)
        t[('upper-body','r')]=cycle([0,.007,0,-.007,0],d)
        t[('ear-left','r')]=[(0,0),(108,0),(115,-.12),(123,.035),(134,0),(480,0)]
        t[('ear-right','r')]=[(0,0),(332,0),(340,.09),(349,-.025),(360,0),(480,0)]
        t[('ambient-glance','x')]=[(0,0),(160,0),(180,6),(230,6),(252,0),(480,0)]
    elif i==1:
        t[('upper-body','r')]=cycle([0,-.038,-.052,-.038,0],d)
        t[('upper-body','sy')]=cycle([1,1.007,1,1.007,1],d)
        t[('ambient-glance','x')]=[(0,0),(40,9),(130,9),(160,-5),(215,-5),(265,0),(300,0)]
        t[('ambient-glance','y')]=[(0,0),(40,-8),(215,-8),(265,0),(300,0)]
        t[('ear-left','r')]=cycle([0,.1,.1,-.035,0],d)
        t[('ear-right','r')]=cycle([0,-.12,-.08,0,0],d)
    elif i==2:
        t[('upper-body','y')]=cycle([0,4,0,4,0,4,0,4,0],d)
        t[('upper-body','r')]=cycle([0,-.018,0,.018,0],d)
        t[('ambient-glance','x')]=cycle([0,-6,-6,6,6,0],d)
        t[('ambient-glance','y')]=cycle([0,5,5,5,5,0],d)
        t[('foot-right','r')]=[(0,0),(60,0),(72,-.055),(84,0),(150,0),(162,-.055),(174,0),(240,0)]
    elif i==3:
        t[('upper-body','r')]=cycle([0,.045,.045,0,0],d)
        t[('ear-left','r')]=cycle([0,.16,.16,0,0],d)
        t[('ear-right','r')]=cycle([0,-.16,-.16,0,0],d)
        t[('upper-body','sy')]=cycle([1,1.018,1,1,1],d)
    elif i==4:
        t[('activity-body','y')]=[(0,-108),(15,-99),(30,-137),(48,-108),(57,-103),(72,-108),(150,-108)]
        t[('upper-body','sy')]=[(0,1),(15,.965),(30,1.03),(48,.965),(70,1),(150,1)]
        t[('upper-body','sx')]=[(0,1),(15,1.025),(30,.985),(48,1.025),(70,1),(150,1)]
        t[('ear-left','r')]=[(0,0),(15,-.08),(33,.18),(54,-.09),(78,0),(150,0)]
        t[('ear-right','r')]=[(0,0),(15,.08),(33,-.18),(54,.09),(78,0),(150,0)]
        t[('foot-left','r')]=[(0,0),(30,.10),(55,0),(150,0)]
        t[('foot-right','r')]=[(0,0),(30,-.10),(55,0),(150,0)]
        t[('shadow','sx')]=[(0,1),(30,.82),(50,1),(150,1)]
        t[('shadow','o')]=[(0,1),(30,.65),(50,1),(150,1)]
    timeline(name,d,t,loop=i!=4)

emotions=['Neutral','Excited','Sad','Tired','Curious','Content','Surprised','Uncertain']
def base_emotion():
    t={('emotion-body','y'):0,('emotion-body','r'):0,('emotion-body','sx'):1,('emotion-body','sy'):1,
        ('ear-left-emotion','r'):0,('ear-right-emotion','r'):0}
    for s in ('left','right'):
        for prop,v in [('sx',1),('sy',1),('r',0),('y',0)]: t[('eye-'+s+'-expression',prop)]=v
        t[('eye-'+s+'-smile','o')]=0; t[('eye-'+s+'-open','o')]=1
    return t
for i,name in enumerate(emotions):
    t=base_emotion(); d=240
    if i==1:
        t[('emotion-body','y')]=cycle([0,-9,0,-5,0,0,0],d)
        t[('emotion-body','sy')]=cycle([1,1.015,1,1.01,1,1,1],d)
        t[('ear-left-emotion','r')]=cycle([.10,.19,.10,.16,.10,.10,.10],d)
        t[('ear-right-emotion','r')]=cycle([-.10,-.19,-.10,-.16,-.10,-.10,-.10],d)
        for s in ('left','right'): t[('eye-'+s+'-open','o')]=0; t[('eye-'+s+'-smile','o')]=1
    elif i==2:
        t[('emotion-body','y')]=5; t[('emotion-body','sy')]=.98
        t[('ear-left-emotion','r')]=-.23; t[('ear-right-emotion','r')]=.23
        for s,sign in [('left',1),('right',-1)]:
            t[('eye-'+s+'-expression','sy')]=.68; t[('eye-'+s+'-expression','r')]=sign*.17
            t[('eye-'+s+'-expression','y')]=6
    elif i==3:
        t[('emotion-body','r')]=cycle([-.018,-.027,-.018],d)
        t[('emotion-body','sy')]=.985
        t[('ear-left-emotion','r')]=-.14; t[('ear-right-emotion','r')]=.14
        for s in ('left','right'): t[('eye-'+s+'-expression','sy')]=cycle([.4,.31,.4],d)
    elif i==4:
        t[('emotion-body','r')]=-.045; t[('ear-left-emotion','r')]=.12; t[('ear-right-emotion','r')]=-.2
        t[('eye-right-expression','sy')]=1.08; t[('eye-left-expression','sy')]=.86
    elif i==5:
        t[('emotion-body','sy')]=1.012
        t[('ear-left-emotion','r')]=.06; t[('ear-right-emotion','r')]=-.06
        for s in ('left','right'):
            t[('eye-'+s+'-open','o')]=0; t[('eye-'+s+'-smile','o')]=1
            t[('eye-'+s+'-expression','sy')]=.72
    elif i==6:
        t[('emotion-body','y')]=[(0,0),(8,-9),(20,0),(d,0)]
        t[('ear-left-emotion','r')]=.22; t[('ear-right-emotion','r')]=-.22
        for s in ('left','right'):
            t[('eye-'+s+'-expression','sx')]=1.3; t[('eye-'+s+'-expression','sy')]=1.12
    elif i==7:
        t[('emotion-body','r')]=cycle([.025,.015,.025],d)
        t[('ear-left-emotion','r')]=-.14; t[('ear-right-emotion','r')]=-.10
        t[('eye-left-expression','sy')]=.60; t[('eye-right-expression','sy')]=.88
    timeline(name,d,t,loop=i!=6)

blink_tracks={}
for side,delay in [('left',0),('right',1)]:
    blink_tracks[('eye-'+side+'-blink','sy')]=[(0,1),(110+delay,1),(116+delay,.07),(123+delay,1),(310,1),(316,.07),(322,1),(331,1),(337,.07),(344,1),(480,1)]
timeline('Blink',480,blink_tracks)
timeline('Eyes steady',60,{('eye-'+s+'-blink','sy'):1 for s in ('left','right')})
hover_base={('ear-left-hover','r'):0,('ear-right-hover','r'):0,('hover-body','r'):0}
timeline('Hover rest',60,hover_base)
timeline('Hover hello',70,{('ear-left-hover','r'):[(0,0),(8,.16),(17,-.07),(29,.035),(42,0),(70,0)],
    ('ear-right-hover','r'):[(0,0),(13,-.10),(24,.04),(38,0),(70,0)],
    ('hover-body','r'):[(0,0),(16,-.009),(40,0),(70,0)]},loop=False)

machine=add(board,'StateMachine',name=TITLE,id='0:7')
def condition(parent,prop,value):
    kind=defaults[prop][0]; key=634 if kind=='Boolean' else 636
    cond=add(parent,'TransitionViewModelCondition',opValue='equal')
    left=add(cond,'TransitionPropertyViewModelComparator')
    b=add(left,'BindableProperty'+kind); bind(b,prop,key)
    add(cond,'TransitionValue'+kind+'Comparator',value=str(value).lower())
def layer(name,prop,choices,extra_reduced=False):
    lay=add(machine,'StateMachineLayer',name=name,id=ident('layer-'+name))
    add(lay,'AnyState',x=0,y=-150); add(lay,'ExitState',x=0,y=150)
    ent=add(lay,'EntryState',x=0,y=0)
    add(ent,'StateTransition',stateToId=ident('state-'+name+'-0'))
    states=[]
    for i,(value,anim) in enumerate(choices):
        state=add(lay,'AnimationState',animationId=ident('anim-'+anim),reset='true',x=220+(i%4)*220,y=(i//4)*180,id=ident('state-'+name+'-'+str(i)))
        states.append(state)
    for i,state in enumerate(states):
        for j,(value,anim) in enumerate(choices):
            if i==j: continue
            trans=add(state,'StateTransition',stateToId=ident('state-'+name+'-'+str(j)),duration=220,enableEarlyExit='true')
            condition(trans,prop,value)
    return lay
layer('Activity','activity',list(enumerate(activity_names)))
layer('Emotion','emotion',list(enumerate(emotions)))
layer('Blink','reducedMotion',[(False,'Blink'),(True,'Eyes steady')])
layer('Hover','hovered',[(False,'Hover rest'),(True,'Hover hello')])

# Reduced-motion overrides every animated pose; the host also centres gaze.
reduced=add(machine,'StateMachineLayer',name='Reduced motion',id=ident('reduced-layer'))
add(reduced,'AnyState',x=0,y=-150); add(reduced,'ExitState',x=0,y=150)
entry=add(reduced,'EntryState',x=0,y=0)
timeline('No override',60,{})
static=base_action() | base_emotion() | hover_base
static.update({('eye-'+s+'-blink','sy'):1 for s in ('left','right')})
timeline('Reduced pose',60,static)
add(entry,'StateTransition',stateToId=ident('reduce-off'))
for on,anim,target in [(False,'No override',True),(True,'Reduced pose',False)]:
    state=add(reduced,'AnimationState',animationId=ident('anim-'+anim),id=ident('reduce-on' if on else 'reduce-off'),x=220 if not on else 440,y=0)
    transition=add(state,'StateTransition',stateToId=ident('reduce-on' if target else 'reduce-off'),duration=0)
    condition(transition,'reducedMotion',target)

E.indent(doc,space='  ')
(ROOT/'scene.rml').write_text(E.tostring(doc,encoding='unicode')+'\n')
(ROOT/'rive.yaml').write_text('name: '+NAME+'\n')
(ROOT/'contract.json').write_text(json.dumps({'name':NAME,'profile':PROFILE,'artboard':TITLE,'stateMachine':TITLE,'viewModel':TITLE,
    'activities':dict(enumerate(activity_names)),'emotions':dict(enumerate(emotions)),
    'properties':{k:{'type':v[0],'default':v[1]} for k,v in defaults.items()},
    'palette':COLORS,'parts':list(parts),'sourceSvgSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest()},indent=2)+'\n')
print('Wrote native vector rig,', len(list(doc.iter())), 'Rive objects')
