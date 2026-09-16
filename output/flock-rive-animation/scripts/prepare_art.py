"""Build complete vector anatomy from the approved expanded concept card."""
from pathlib import Path
import sys, json, subprocess, hashlib, xml.etree.ElementTree as E
from collections import deque
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0,'/private/tmp/flock-parts-deps')
import pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT=Path(__file__).resolve().parents[1]
SOURCE=json.loads((ROOT/'source.json').read_text())
NS={'s':'http://www.w3.org/2000/svg'}
INK='#151416'; EYE='#fcf6e3'
CONFIG={
'chill':{'palette':['#151416','#353b40','#76cafa','#fcf6e3'],'primary':'#76cafa','eyes':[(175,287,16,40),(217,287,16,40)],'profile':'flow','parts':[
 ('foot-left',(132,405),'#353b40','M119 379C131 371 149 376 152 389L150 426Q147 445 137 445L113 442Q107 440 112 425Z'),
 ('foot-right',(251,405),'#353b40','M236 379Q252 369 265 389L278 435Q278 442 268 443L247 445Q239 442 236 428Z'),
 ('fur',(194,350),'#76cafa','auto') ]},
'nudge':{'palette':['#151416','#343739','#ffad32','#fcf6e3'],'primary':'#ffad32','eyes':[(555,287,16,40),(597,287,16,40)],'profile':'bounce','parts':[
 ('foot-left',(510,405),'#343739','M496 378Q512 370 528 389L522 431Q519 446 503 446L486 442Q481 437 487 423Z'),
 ('foot-right',(633,405),'#343739','M616 377Q634 369 646 389L656 435Q655 445 642 446L624 446Q615 442 614 431Z'),
 ('fur',(570,350),'#ffad32','auto')]},
'fox':{'palette':['#151416','#30312e','#ff852a','#fff2d7','#fcf6e3'],'primary':'#ff852a','eyes':[(920,257,16,39),(962,257,16,39)],'profile':'seated-alert','parts':[
 ('tail',(1011,414),'#ff852a','M1003 398C1018 381 1027 332 1055 310C1073 295 1093 289 1108 288C1124 311 1136 344 1125 380C1110 425 1071 447 1030 436L1005 428Z'),
 ('haunch-left',(886,414),'#ff852a','M887 365C863 365 848 391 849 409C850 426 858 435 879 438L909 433L906 391Z'),
 ('haunch-right',(1000,414),'#ff852a','M995 365C1020 366 1033 390 1031 410C1030 425 1017 437 997 438L975 431L978 390Z'),
 ('fur',(941,385),'#ff852a','M885 305C865 330 860 359 872 383C883 407 903 433 939 436C973 436 999 411 1009 381C1020 350 1008 325 989 305Z'),
 ('foot-left',(895,394),'#30312e','M875 374C885 372 906 378 910 390L919 433Q921 448 910 448L868 448Q857 448 861 437Q865 425 884 423Z'),
 ('foot-right',(979,394),'#30312e','M969 389C974 377 994 372 1003 375L994 423Q1010 422 1018 437Q1023 448 1012 448L970 448Q958 448 961 434Z'),
 ('ear-left',(879,188),'#ff852a','M844 84C838 82 828 118 825 143C822 166 826 205 835 225L882 207L919 179C895 137 871 102 844 84Z'),
 ('ear-right',(1008,189),'#ff852a','M1044 84C1050 81 1060 118 1063 147C1066 174 1061 205 1051 227L1005 210L966 178C989 137 1015 103 1044 84Z'),
 ('head',(942,316),'#ff852a','M945 147L950 145L951 162L969 156C992 167 1015 183 1036 207C1055 228 1074 236 1089 241L1065 256L1078 267L1057 279L1076 287L1031 302L1038 312L1003 313C980 324 960 326 941 326C918 326 896 322 878 313L843 313L848 298L808 288L828 272L805 258L816 252L794 241C818 234 841 218 857 201C876 181 900 169 920 168Q932 153 945 147Z')]},
'goat':{'palette':['#151416','#393c3d','#c5a77c','#e9a4a1','#fff3d8','#fcf6e3'],'primary':'#fff3d8','eyes':[(177,675,13,37),(211,675,13,37)],'profile':'standing','parts':[
 ('tail',(254,779),'#fff3d8','M244 762Q270 763 283 743C294 767 292 787 256 800Z'),
 ('foot-left',(158,844),'#fff3d8','M140 809Q159 798 178 813L176 869L182 899Q180 908 164 908L134 906Q125 905 128 897L138 870Z'),
 ('foot-right',(224,844),'#fff3d8','M205 813Q223 800 239 812L245 870L260 899Q261 907 248 907L220 909Q205 909 206 900L210 871Z'),
 ('fur',(192,808),'#fff3d8','M156 711C144 736 130 760 127 787C124 814 132 837 143 852L140 868Q158 876 178 870L175 838Q183 859 194 860Q203 857 213 838L211 870Q231 876 245 868L241 850C256 827 263 804 260 782C256 754 243 730 233 711Z'),
 ('ear-left',(139,638),'#fff3d8','M144 620C110 601 79 606 37 625C40 640 54 654 75 661C96 670 122 659 143 643Z'),
 ('ear-right',(244,638),'#fff3d8','M240 620C274 602 306 607 348 625C344 641 330 655 309 662C289 669 263 659 241 643Z'),
 ('head',(194,730),'#fff3d8','M146 610C140 594 136 570 124 551Q113 538 97 540Q96 534 106 529C145 506 172 548 179 591L209 591C219 548 247 509 284 526Q297 533 293 538Q279 537 268 549C253 570 250 594 245 610C259 629 268 648 267 670C267 700 248 719 215 729L212 759L200 750L194 783L179 757L175 764L169 730C137 722 119 701 120 673C120 648 130 626 146 610Z')]},
'cow':{'palette':['#151416','#36393a','#4c4d4b','#f7a4a8','#ffe4ad','#fff4d9','#fcf6e3'],'primary':'#fff4d9','eyes':[(557,680,16,40),(595,680,16,40)],'profile':'standing-heavy','parts':[
 ('tail',(686,708),'#fff4d9','M681 699C711 704 724 735 730 764L741 779L729 802C711 797 708 774 710 757C710 735 700 719 681 719Z'),
 ('tail-tip',(731,780),'#4c4d4b','M730 767C760 778 763 801 742 832L731 813L728 820C713 808 714 789 730 767Z'),
 ('foot-left',(485,856),'#36393a','M460 826L515 825L521 897Q520 908 497 909L461 907Q447 906 452 894Z'),
 ('foot-right',(658,856),'#36393a','M631 825L683 825L693 896Q697 908 676 910L639 909Q622 908 623 899Z'),
 ('ear-left',(489,641),'#4c4d4b','M496 627C466 599 430 607 410 627C395 641 401 655 420 669C442 684 466 674 489 657Z'),
 ('ear-right',(657,641),'#4c4d4b','M650 626C680 598 717 608 738 630C752 643 747 657 728 670C704 684 681 673 655 656Z'),
 ('fur',(573,801),'#fff4d9','M511 601C545 582 590 581 624 600C646 613 660 637 673 667C690 704 703 749 704 784C707 814 699 838 685 854L688 867Q663 877 630 867L636 841Q621 862 589 862L546 860Q520 858 511 841L518 867Q487 877 457 867L462 851C443 829 435 805 438 775C441 736 454 698 468 668C482 636 495 613 511 601Z'),
 ('horn-left',(509,611),'#ffe4ad','M527 596C511 589 513 574 511 566Q502 560 493 579C482 604 492 621 510 623Q526 620 531 603Z'),
 ('horn-right',(637,611),'#ffe4ad','M621 596C637 589 637 574 642 566Q651 560 660 579C670 604 659 621 642 623Q626 620 618 603Z')]},
'cat':{'palette':['#151416','#322a3d','#624b7c','#c398f1','#fcf6e3'],'primary':'#c398f1','eyes':[(928,701,14,39),(966,701,14,39)],'profile':'seated-slinky','parts':[
 ('tail',(1024,873),'#c398f1','M1012 856C1050 860 1064 832 1064 805C1064 782 1053 757 1066 729C1076 705 1096 697 1110 709C1127 723 1107 738 1100 759C1093 784 1101 803 1094 828C1085 861 1065 881 1026 880Z'),
 ('foot-left',(897,890),'#322a3d','M877 875Q895 868 913 881L915 902Q907 910 882 907Q868 905 873 897Z'),
 ('foot-right',(995,890),'#322a3d','M977 881Q994 870 1010 879L1019 899Q1024 907 1008 908L980 907Z'),
 ('fur',(945,846),'#c398f1','M910 733L985 733C1000 753 1008 784 1015 805C1036 825 1044 844 1037 863C1033 880 1018 888 997 889L982 904Q973 912 960 907L946 910L933 908Q918 913 909 902L904 889C881 890 862 881 856 865C847 845 854 825 876 806C885 779 896 747 910 733Z'),
 ('ear-left',(894,650),'#c398f1','M863 578C855 585 850 616 853 650L861 686L907 669L925 630C903 605 884 585 863 578Z'),
 ('ear-right',(1000,650),'#c398f1','M1027 578C1037 586 1042 618 1040 650L1033 686L984 669L966 630C989 605 1008 585 1027 578Z'),
 ('head',(947,744),'#c398f1','M923 625C934 619 956 619 968 625C984 631 1008 647 1024 667C1037 683 1044 701 1037 718C1028 740 1001 753 975 755L919 755C892 753 866 741 856 721C848 704 854 685 868 668C884 649 907 630 923 625Z'),
 ('whiskers',(947,713),'#151416','M834 703Q850 698 870 707L869 711Q850 705 835 709Z M841 722Q853 713 870 716L870 720Q855 719 843 727Z M1023 706Q1043 699 1058 704L1057 709Q1041 705 1024 711Z M1023 716Q1041 713 1054 723L1052 728Q1039 720 1023 720Z')]},
'rabbit':{'palette':['#151416','#50ac75','#a9efb4','#fcf6e3'],'primary':'#a9efb4','eyes':[(1319,711,13,33),(1350,711,13,33)],'profile':'seated-tapper','parts':[
 ('foot-left',(1288,896),'#a9efb4','M1298 878C1275 879 1255 865 1234 870C1216 873 1207 885 1213 900C1221 918 1259 911 1288 904L1310 896Z'),
 ('foot-right',(1380,896),'#a9efb4','M1372 878C1394 880 1415 865 1436 871C1453 875 1461 889 1453 902C1441 918 1408 910 1380 904L1361 897Z'),
 ('haunch-left',(1278,865),'#a9efb4','M1293 813C1266 803 1242 818 1241 842C1239 861 1252 878 1273 884L1302 877Z'),
 ('haunch-right',(1392,865),'#a9efb4','M1376 813C1403 804 1426 817 1427 840C1430 860 1417 879 1395 884L1365 877Z'),
 ('fur',(1336,843),'#a9efb4','M1302 743C1281 761 1271 788 1269 815C1268 843 1277 867 1286 884L1306 901Q1319 909 1333 900Q1347 908 1361 901L1381 884C1391 861 1397 838 1396 815C1395 787 1385 762 1364 743Z'),
 ('ear-left',(1293,653),'#a9efb4','M1286 679C1262 645 1248 617 1250 577C1250 551 1261 525 1275 523C1290 521 1309 544 1316 574C1323 603 1324 632 1319 657Z'),
 ('ear-right',(1379,653),'#a9efb4','M1354 657C1351 626 1356 596 1365 570C1374 542 1390 523 1401 525C1416 529 1419 556 1416 584C1414 621 1400 651 1383 677Z'),
 ('head',(1334,756),'#a9efb4','M1307 648C1321 641 1345 639 1359 648C1378 654 1399 678 1407 699C1416 722 1404 742 1383 751C1355 764 1314 764 1287 750C1264 738 1254 719 1263 696C1273 672 1289 655 1307 648Z') ]}
}

EAR_INSETS={
 'fox': [('#30312e','M851 116Q873 139 885 173Q857 185 842 206Q837 159 851 116Z'),('#30312e','M1037 117Q1014 141 1001 174Q1028 186 1045 207Q1050 159 1037 117Z')],
 'goat':[('#e9a4a1','M62 635Q93 622 126 639Q99 658 77 649Z'),('#e9a4a1','M260 639Q293 622 325 635L310 649Q287 658 260 639Z')],
 'cow':[('#f7a4a8','M414 650Q443 625 479 647Q452 683 424 662Z'),('#f7a4a8','M669 646Q702 626 735 649L724 662Q696 682 669 646Z')],
 'cat':[('#624b7c','M870 605Q890 615 903 636Q878 646 864 664Q860 632 870 605Z'),('#624b7c','M1020 605Q1001 615 990 636Q1014 646 1030 665Q1034 632 1020 605Z')],
 'rabbit':[('#50ac75','M1285 562C1298 570 1306 613 1305 649L1294 660C1278 632 1270 598 1276 574Q1278 562 1285 562Z'),('#50ac75','M1392 562C1379 570 1368 613 1364 649L1375 660C1392 633 1401 598 1399 575Q1398 562 1392 562Z')]
}

# Closed, deliberately drawn markings replace texture-derived boundaries on
# the non-wool characters. They keep their contours smooth at avatar scale.
MARKINGS={
 'fox':{
  'head':[
   ('#fff2d7','M795 241L856 245C866 276 885 296 918 306C952 318 990 303 1009 257L1024 246L1089 241L1065 256L1078 267L1057 279L1076 287L1031 302L1038 312L1003 313C980 324 960 326 941 326C918 326 896 322 878 313L843 313L848 298L808 288L828 272L805 258L816 252Z',0),
   (INK,'M880 237C905 229 928 215 944 195C957 215 978 227 1004 238C1013 275 987 299 945 300C902 302 868 278 880 237Z',0)],
  'fur':[('#fff2d7','M895 309Q942 323 988 309L990 341L979 333L978 362L968 351L963 375L954 370L941 395L925 376L918 374L911 354L904 365L902 338L894 347Z',3)],
  'tail':[('#fff2d7','M1108 288C1124 311 1136 344 1125 380L1116 389L1114 365L1094 386L1094 351L1068 364L1069 342L1045 353C1062 315 1089 293 1108 288Z',0)]},
 'goat':{'head':[
   ('#c5a77c','M146 610C140 594 136 570 124 551Q113 538 97 540Q96 534 106 529C145 506 172 548 179 591L176 600Z',0),
   ('#c5a77c','M209 591C219 548 247 509 284 526Q297 533 293 538Q279 537 268 549C253 570 250 594 245 610L213 601Z',0),
   (INK,'M127 554Q142 541 158 547M136 575Q152 562 169 569M142 595Q159 582 176 590M218 570Q235 560 251 574M228 548Q246 541 263 554M212 590Q229 582 247 595',2.6),
   (INK,'M159 645Q183 639 194 622Q205 639 228 646C248 659 249 684 233 700C214 718 175 718 154 701C136 686 139 660 159 645Z',0)],
  'fur':[(INK,'M174 820Q177 841 193 856Q209 842 214 820',2.4)]},
 'cow':{'fur':[
   ('#4c4d4b','M468 694C489 690 490 710 496 722C502 734 522 736 522 755C524 778 512 786 493 782C475 780 469 793 451 784L439 775L447 735Z',0),
   ('#4c4d4b','M679 696C662 695 666 719 658 730C643 747 650 769 664 777C677 784 680 804 696 802L704 783L699 741Z',0),
   ('#4c4d4b','M596 786C611 779 624 788 619 804C613 819 626 827 616 842C607 856 583 850 569 843C553 835 558 815 570 807Q585 802 596 786Z',0),
   ('#4c4d4b','M613 597Q619 605 634 611L644 628Q646 642 637 643Q626 645 622 634Q609 636 607 624Q601 611 613 597Z',0),
   (INK,'M548 643C529 645 514 656 514 677C514 706 535 722 574 722C611 722 636 706 636 678C636 653 613 641 582 641Z',0)]},
 'cat':{'head':[(INK,'M897 679Q929 669 945 649Q962 669 985 677C1008 690 1008 713 990 728C970 746 925 746 903 731C883 717 882 692 897 679Z',0)],
  'fur':[(INK,'M896 825Q903 868 915 894Q918 900 912 904M946 835L946 898M986 826Q978 866 970 894Q967 901 973 904',3)]},
 'rabbit':{'head':[(INK,'M1317 678C1298 680 1287 691 1287 709C1287 732 1305 746 1333 746C1364 746 1383 732 1383 709C1383 688 1363 677 1341 677Z',0)],
  'fur':[(INK,'M1306 827Q1307 868 1315 898M1333 830L1333 899M1361 827Q1359 869 1351 898',2.8)],
  'foot-left':[(INK,'M1234 892Q1228 897 1230 905',2.4)],
  'foot-right':[(INK,'M1436 892Q1443 899 1440 906',2.4)]}
}

def P(d):
    p=pathops.Path();parse_path(d,p.getPen());return p
def svgpath(p):
    pen=SVGPathPen(None,ntos=lambda n:str(round(n,3)));p.draw(pen);return pen.getCommands()
def boolean(a,b,kind): return pathops.op(a,b,getattr(pathops.PathOp,kind))
def expand(p,r):
    q=pathops.Path(p);q.stroke(abs(r)*2,pathops.LineCap.ROUND_CAP,pathops.LineJoin.ROUND_JOIN,4);q.convertConicsToQuads(.02)
    return boolean(p,q,'UNION' if r>0 else 'DIFFERENCE')
def transform(p,t):
    q=pathops.Path();p.draw(TransformPen(q.getPen(),t));return q
def fill_holes(mask):
    h,w=mask.shape;exterior=np.zeros_like(mask);q=deque([(0,0)])
    while q:
        x,y=q.popleft()
        if x<0 or y<0 or x>=w or y>=h or exterior[y,x] or mask[y,x]:continue
        exterior[y,x]=True;q.extend(((x-1,y),(x+1,y),(x,y-1),(x,y+1)))
    return ~exterior
def trace(mask,name,tmp):
    Image.fromarray(np.where(mask,0,255).astype('uint8')).convert('1').save(tmp/(name+'.pbm'))
    subprocess.run(['potrace',str(tmp/(name+'.pbm')),'-s','--flat','-t','8','-O','.6','-u','100','-o',str(tmp/(name+'.svg'))],check=True,stdout=subprocess.DEVNULL)
    tree=E.parse(tmp/(name+'.svg'));out=pathops.Path()
    for path in tree.findall('.//s:path',NS):parse_path(path.get('d'),TransformPen(out.getPen(),(.01,0,0,-.01,0,mask.shape[0])))
    return out
def capsule(cx,cy,w,h):
    x=cx-w/2;y=cy-h/2;r=w/2;k=.55228475*r
    return P(f'M{x+r} {y}C{x+r+k} {y} {x+w} {y+r-k} {x+w} {y+r}V{y+h-r}C{x+w} {y+h-r+k} {x+r+k} {y+h} {x+r} {y+h}C{x+r-k} {y+h} {x} {y+h-r+k} {x} {y+h-r}V{y+r}C{x} {y+r-k} {x+r-k} {y} {x+r} {y}Z')

def build(name,cfg):
    dest=ROOT/'characters'/name;dest.mkdir(parents=True,exist_ok=True)
    tmp=dest/'trace-work';tmp.mkdir(exist_ok=True)
    left,top,right,bottom=SOURCE['crops'][name];w,h=right-left,bottom-top
    rgb=np.asarray(Image.open(ROOT/'assets'/f'{name}-concept.png').convert('RGB')).astype(float)
    fg=fill_holes(np.min(rgb,axis=2)<110)
    colors=cfg['palette'][:]
    # Two almost-white classes would turn paper texture into hundreds of islands.
    # Eyes are rebuilt separately, so a cream coat/marking needs only one white.
    if any(c not in (EYE,INK) and min(int(c[i:i+2],16) for i in (1,3,5))>190 for c in colors):
        colors=[c for c in colors if c!=EYE]
    palette=np.array([[int(c[i:i+2],16) for i in (1,3,5)] for c in colors])
    labels=((rgb[:,:,None,:]-palette[None,None,:,:])**2).sum(3).argmin(2)
    layers=[]
    for i,col in enumerate(colors):
        mask=(labels==i)&fg
        mask=np.asarray(Image.fromarray((mask*255).astype('uint8')).filter(ImageFilter.MedianFilter(3)))>127
        layers.append((col,trace(mask,'palette-'+str(i),tmp)))
    scale=min(440/w,580/h);tx=(457-w*scale)/2;ty=598-h*scale
    norm=(scale,0,0,scale,tx,ty)
    global_to_local=(1,0,0,1,-left,-top)
    svg=E.Element('svg',xmlns='http://www.w3.org/2000/svg',width='457',height='615',viewBox='0 0 457 615')
    E.SubElement(svg,'title').text=name.title()+' — complete animation parts'
    meta={'name':name,'width':457,'height':615,'profile':cfg['profile'],'sourceCrop':SOURCE['crops'][name],
        'conceptSha256':hashlib.sha256((ROOT/'assets'/f'{name}-concept.png').read_bytes()).hexdigest(),
        'palette':{'primary':cfg['primary'],'shade':cfg['primary'],'eyeColor':EYE},'parts':[]}
    eye_patches=[capsule(cx-left,cy-top,ew+5,eh+5) for cx,cy,ew,eh in cfg['eyes']]
    for part,pivot,base,d in cfg['parts']:
        if name=='goat' and part.startswith('foot-'):base='#393c3d'
        if d=='auto':
            primaryidx=colors.index(cfg['primary'])
            mask=np.asarray(Image.fromarray((((labels==primaryidx)&fg)*255).astype('uint8')).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3)))>127
            mask=fill_holes(mask)
            shape=trace(mask,'body-base',tmp)
        else:shape=transform(P(d),global_to_local)
        line=expand(shape,3.0 if part=='whiskers' else 3.5)
        px=(pivot[0]-left)*scale+tx;py=(pivot[1]-top)*scale+ty
        group=E.SubElement(svg,'g',id=name+'-'+part,**{'data-part':part,'data-pivot':f'{px:.3f} {py:.3f}'})
        def draw(p,color,role=None):
            if not list(p.contours):return
            attrs={'fill':color,'d':svgpath(transform(p,norm))}
            if role:attrs['data-color-role']=role
            E.SubElement(group,'path',**attrs)
        if part=='whiskers':draw(shape,INK)
        else:
            draw(line,INK);draw(shape,base,'primary' if base==cfg['primary'] else None)
            # Reuse only interior markings. The complete smooth outside edge belongs to this part.
            interior=expand(shape,-6.0)
            for color,region in layers:
                if name in MARKINGS:continue
                if color==base:continue
                if part.startswith('ear-') or part=='whiskers':continue
                if part.startswith('foot-'):continue
                paint=boolean(region,interior,'INTERSECTION')
                for eye in eye_patches:paint=boolean(paint,eye,'DIFFERENCE')
                clean=pathops.Path()
                for contour in paint.contours:
                    if abs(contour.area)>18:clean.addPath(contour)
                paint=clean
                draw(paint,color,'primary' if color==cfg['primary'] else None)
            if part.startswith('ear-') and name in EAR_INSETS:
                color,inset=EAR_INSETS[name][0 if part.endswith('left') else 1]
                inset=transform(P(inset),global_to_local)
                draw(expand(inset,1.4),INK);draw(inset,color)
            for color,detail,width in MARKINGS.get(name,{}).get(part,[]):
                detail=transform(P(detail),global_to_local)
                if width:
                    if color==INK:
                        detail.stroke(width,pathops.LineCap.ROUND_CAP,pathops.LineJoin.ROUND_JOIN,4)
                        detail.convertConicsToQuads(.02)
                    else:draw(expand(detail,width/2),INK)
                draw(boolean(detail,shape,'INTERSECTION'),color)
            # Removing the old eyes exposes a continuous filled face, rather than two holes.
            if part in ('head','fur'):
                for eye in eye_patches:
                    if boolean(eye,interior,'INTERSECTION').area>eye.area*.9:draw(eye,INK)
        bounds=transform(line,norm).bounds
        meta['parts'].append({'id':part,'pivot':[round(px,3),round(py,3)],'bounds':list(bounds),'layer':len(meta['parts']),'hasCompletion':True})
    for side,(cx,cy,ew,eh) in zip(('left','right'),cfg['eyes']):
        part='eye-'+side;px=(cx-left)*scale+tx;py=(cy-top)*scale+ty
        group=E.SubElement(svg,'g',id=name+'-'+part,**{'data-part':part,'data-pivot':f'{px:.3f} {py:.3f}'})
        shape=transform(capsule(cx-left,cy-top,ew,eh),norm)
        E.SubElement(group,'path',fill=EYE,d=svgpath(shape),**{'data-color-role':'eyeColor'})
        meta['parts'].append({'id':part,'pivot':[round(px,3),round(py,3)],'bounds':list(shape.bounds),'layer':len(meta['parts']),'hasCompletion':True})
    E.indent(svg,space='  ')
    (dest/(name+'.svg')).write_text(E.tostring(svg,encoding='unicode')+'\n')
    (dest/(name+'.json')).write_text(json.dumps(meta,indent=2)+'\n')
    Image.fromarray((fg*255).astype('uint8')).save(dest/'foreground.png')
    print(name,len(meta['parts']),'complete vector parts',flush=True)

if __name__=='__main__':
    for name,cfg in CONFIG.items():build(name,cfg)
    subprocess.run([sys.executable,str(Path(__file__).with_name('prepare_dog.py'))],check=True)
