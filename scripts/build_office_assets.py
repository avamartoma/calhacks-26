"""Authored for execution through Blender MCP. Units are metres; Three.js axes are converted at creation."""
import bpy
import math
import os
from pathlib import Path

ROOT = Path(os.environ.get("FOURTEENTH_ROOT", Path.cwd())).resolve()
(ROOT / "assets").mkdir(exist_ok=True)
(ROOT / "public/models").mkdir(parents=True, exist_ok=True)
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def material(name, color, metallic=0, rough=.5, alpha=1):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, alpha)
    bs.inputs['Metallic'].default_value = metallic
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Alpha'].default_value = alpha
    m.diffuse_color = (*color, alpha)
    if alpha < 1:
        m.surface_render_method = 'DITHERED'
    return m

stone = material('Honed limestone', (.53, .55, .53), 0, .38)
tileA = material('Porcelain warm gray A', (.63, .65, .63), 0, .3)
tileB = material('Porcelain warm gray B', (.59, .61, .60), 0, .34)
carpet = material('Graphite carpet', (.12, .16, .17), 0, 1)
carpetAlt = material('Graphite carpet alternating weave', (.145, .185, .18), 0, 1)
walnut = material('Oiled walnut', (.23, .115, .055), 0, .36)
walnutLight = material('Walnut veneer variation', (.31, .175, .085), 0, .39)
steel = material('Brushed aluminum', (.49, .53, .54), .82, .25)
black = material('Charcoal powder coat', (.055, .066, .072), .35, .5)
rubber = material('Soft black polymer', (.025, .031, .035), 0, .8)
leather = material('Cognac leather upholstery', (.25, .105, .045), 0, .5)
fabric = material('Slate acoustic felt', (.16, .22, .23), 0, .96)
white = material('Warm white painted gypsum', (.78, .8, .78), 0, .8)
glass = material('Low iron curtain wall glazing', (.59, .77, .81), .1, .08, .13)
water = material('Translucent blue water bottle', (.24, .47, .59), .1, .16, .76)
leafA = material('Ficus leaf dark', (.05, .16, .075), 0, .7)
leafB = material('Ficus leaf light', (.10, .23, .095), 0, .72)
soil = material('Potting soil', (.075, .055, .03), 0, 1)
pot = material('Ceramic planter', (.25, .29, .27), 0, .5)
light = material('LED diffuser', (.9, .92, .85), 0, .4)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Color'].default_value = (.9, .94, .85, 1)
light.node_tree.nodes.get('Principled BSDF').inputs['Emission Strength'].default_value = 2

def cube(name, x, y, z, w, h, d, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -z, y))
    o = bpy.context.object
    o.name = name
    o.dimensions = (w, d, h)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel:
        mod = o.modifiers.new('Machined edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        mod = o.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    return o

def cyl(name, x, y, z, radius, depth, mat, verts=24, radius2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius if radius2 is None else radius2, radius2=radius, depth=depth, location=(x, -z, y))
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth = True
    return o

def rod(name, start, end, radius, mat, verts=12):
    a = Vector((start[0], -start[2], start[1]))
    b = Vector((end[0], -end[2], end[1]))
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=(b-a).length, location=(a+b)/2)
    o = bpy.context.object
    o.name = name
    o.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth = True
    return o

def chair(x, z, executive=False):
    upholstery = leather if executive else rubber
    cyl('Polished pneumatic lift', x, .37, z, .035, .45, steel)
    cyl('Lift cover', x, .29, z, .052, .20, rubber)
    for i in range(5):
        ang = i*math.pi*2/5
        dx, dz = math.cos(ang)*.48, math.sin(ang)*.48
        rod('Five star aluminum base', (x,.24,z), (x+dx,.13,z+dz), .026, steel)
        for side in [-1,1]:
            wheel=cyl('Twin wheel caster', x+dx+side*.029, .085, z+dz, .065, .035, rubber, 16)
            wheel.rotation_euler[1] = math.pi/2
    cube('Ergonomic seat shell',x,.61,z,.77,.12,.7,black,.045)
    cube('Upholstered seat cushion',x,.69,z-.025,.73,.13,.67,upholstery,.055)
    cube('Seat adjustment paddle',x+.43,.57,z+.07,.18,.025,.09,rubber,.01)
    rod('Backrest support spine',(x,.5,z+.22),(x,1.32,z+.4),.035,steel)
    # Mesh back with true openings: repeated curved horizontal and vertical straps.
    for xx in [-.36,.36]: rod('Backrest frame',(x+xx,.8,z+.34),(x+xx,1.52,z+.4),.028,black)
    rod('Upper backrest frame',(x-.36,1.52,z+.4),(x+.36,1.52,z+.4),.028,black)
    rod('Lower backrest frame',(x-.36,.82,z+.34),(x+.36,.82,z+.34),.028,black)
    for j in range(15):
        yy=.85+j*.043
        cube('Breathable mesh horizontal',x,yy,z+.35+math.sin(j/14*math.pi)*.045,.68,.012,.018,upholstery,.003)
    for j in range(10):
        cube('Breathable mesh vertical',x-.31+j*.069,1.17,z+.376,.007,.63,.012,upholstery,.002)
    cube('Lumbar support',x,.98,z+.415,.53,.09,.07,rubber,.025)
    for side in [-1,1]:
        rod('Armrest upright',(x+side*.41,.6,z+.12),(x+side*.44,1.0,z+.1),.022,steel)
        cube('Soft adjustable armrest',x+side*.44,1.04,z,.14,.07,.47,rubber,.024)
    cube('Adjustable headrest',x,1.66,z+.40,.49,.21,.1,upholstery,.055)

cube('Fourteenth structural slab',0,-.34,0,22,.68,18,stone,.035)
for ix in range(22):
    for iz in range(18):
        cube('Large format stone floor tile',-10.5+ix,.018,-8.5+iz,.988,.027,.988,tileA if (ix+iz)%4 else tileB,.007)
for ix in range(12):
    for iz in range(10):
        cube('Quarter turn carpet tile',-8.85+ix*.92,.047,-.43+iz*.94,.916,.023,.936,carpet if (ix+iz)%2 else carpetAlt)
cube('Manager carpet insert',-6.1,.05,-5.2,8.5,.03,5.8,carpet)
cube('Lounge woven rug',6,.055,-4.8,7.7,.04,6.1,material('Stone wool lounge rug',(.32,.34,.31),0,1),.012)

# Mullions, low sills, floor convectors, glass panes and a real corner condition.
cube('Rear spandrel',0,.53,-8.75,22,1.06,.3,white,.01)
cube('Rear granite sill',0,1.10,-8.72,22,.08,.44,stone,.015)
for i in range(7):
    x=-10.6+i*3.53
    cube('Rear curtain wall mullion',x,2.85,-8.75,.11,3.55,.23,black,.008)
    if i<6:
        cube('Low iron glazed bay',x+1.765,2.84,-8.78,3.40,3.39,.025,glass)
        cube('Convective radiator cover',x+1.765,.21,-8.19,3.0,.34,.29,white,.02)
        for n in range(20): cube('Radiator vent',x+.36+n*.145,.39,-8.19,.05,.008,.19,black)
cube('Rear facade transom',0,3.03,-8.75,22,.075,.17,black,.003)
cube('Rear facade head',0,4.62,-8.75,22,.16,.3,black,.01)
cube('Right spandrel',10.73,.52,-3.8,.25,1.04,10.1,white)
cube('Right sill',10.68,1.1,-3.8,.43,.08,10.1,stone,.012)
for i in range(4):
    z=-8.65+i*3.3
    cube('Right curtain wall mullion',10.73,2.86,z,.21,3.55,.10,black,.006)
    if i<3 and i!=1: cube('Right glass bay',10.76,2.86,z+1.65,.025,3.40,3.18,glass)
cube('Open window upper lintel',10.73,4.62,-3.8,.25,.16,10.1,black)
# The middle bay is genuinely open for the ejection action.
cube('Open window frame',10.72,2.86,-5.25,.065,3.4,.06,steel)

# Manager suite. Clear doorway on front and transparent side wall.
cube('Manager left partition',-10.65,1.77,-5.2,.16,3.5,6.5,white)
for x in [-10.53,-1.7]:
    cube('Manager doorway upright',x,1.78,-2.12,.07,3.55,.09,black)
cube('Manager front glazing head',-6.1,3.56,-2.12,8.9,.08,.09,black)
cube('Manager front glazing half',-8.65,1.78,-2.12,3.7,3.44,.015,glass)
cube('Manager door sidelight',-2.55,1.78,-2.12,1.55,3.44,.015,glass)
for z in [-8.35,-5.25,-2.15]: cube('Manager side glazing upright',-1.7,1.78,z,.075,3.55,.075,black)
cube('Manager side glazing head',-1.7,3.56,-5.25,.075,.08,6.25,black)
cube('Manager side glazing',-1.7,1.78,-5.25,.02,3.44,6.13,glass)
cube('Manager privacy band',-1.675,1.3,-5.25,.005,.32,6.1,material('Etched privacy strip',(.7,.77,.75),0,.8,.36))

# Acoustic cubicle partitions, metal feet and fabric pin strips.
for x in [-5.8,-.7]:
    for z in [.7,4.4]:
        cube('Cubicle fabric rear screen',x,.79,z-1.0,3.4,1.5,.08,fabric,.018)
        cube('Cubicle acoustic return',x-1.68,.79,z,.08,1.5,2.0,fabric,.018)
        cube('Cubicle aluminum top cap',x,1.56,z-1.0,3.45,.036,.11,steel,.008)
        for dx in [-1.45,1.45]: cube('Partition stabilizer foot',x+dx,.07,z-1,.16,.09,.55,steel,.015)
        for j in range(3): cube('Pinned task sheet',x-.9+j*.55,1.19,z-.949,.36,.25,.005,white)

# Realistic task chairs line up with runtime desks.
chair(-6.2,-3.87,True)
for x,z in [(-5.8,1.93),(-.7,1.93),(-5.8,5.63),(-.7,5.63)]: chair(x,z)

# Walnut coffee kitchen and credenza. Individual doors, reveals and metal handles.
for i in range(4):
    x=3.6+i*1.5
    cube('Coffee bar cabinet',x,.53,-7.85,1.48,1.02,.78,walnut,.012)
    for s in [-1,1]:
        cube('Veneer cabinet door',x+s*.36,.57,-7.44,.70,.88,.028,walnutLight,.008)
        rod('Cabinet pull',(x+s*.08,.46,-7.407),(x+s*.08,.74,-7.407),.012,steel)
cube('Quartz coffee worktop',5.85,1.09,-7.85,6.12,.09,.88,stone,.012)
cube('Espresso machine body',8.0,1.43,-7.83,.61,.61,.58,steel,.04)
cube('Espresso front panel',8.0,1.44,-7.53,.51,.44,.02,black,.014)
cube('Drip tray',8.0,1.14,-7.40,.56,.03,.35,black,.008)
for x in [7.85,8.12]:
    cyl('Espresso button',x,1.5,-7.5,.027,.015,steel,16).rotation_euler[0]=math.pi/2
    cyl('Coffee cup',x,1.28,-7.31,.072,.14,white)
    rod('Group head', (x,1.4,-7.5),(x,1.4,-7.25),.025,steel)
for i in range(3): cyl('Stacked ceramic cups',7.0,1.18+i*.12,-7.7,.085,.1,white)

# Lounge sofa with piping, seams and cushions.
cube('Sofa plinth',6.1,.23,-6.65,3.85,.19,1.1,black,.03)
cube('Leather sofa base',6.1,.53,-6.65,3.9,.45,1.16,leather,.11)
cube('Leather sofa back',6.1,1.07,-7.1,3.9,.95,.29,leather,.09)
for x in [4.28,7.92]: cube('Sofa padded arm',x,.83,-6.63,.3,.68,1.22,leather,.075)
for x in [4.95,6.1,7.25]:
    cube('Sofa seat cushion',x,.80,-6.57,1.08,.20,.98,leather,.065)
    cube('Sofa back cushion',x,1.12,-6.96,1.08,.69,.18,leather,.07)
    for dz in [-.4,.4]: rod('Seat stitched piping',(x-.47,.89,-6.57+dz),(x+.47,.89,-6.57+dz),.006,walnutLight,6)
cyl('Lounge round coffee top',6,.61,-4.4,1.06,.07,walnutLight,48)
for ang in [0,2.094,4.189]: rod('Coffee table leg',(6+math.cos(ang)*.5,.58,-4.4+math.sin(ang)*.5),(6+math.cos(ang)*.72,.04,-4.4+math.sin(ang)*.72),.025,black)
cube('Design journal',6.1,.665,-4.4,.4,.025,.55,white,.005)
cube('Journal cover',6.1,.684,-4.4,.405,.008,.555,walnut)
cyl('Water glass',5.5,.76,-4.4,.07,.24,glass)

cube('Water dispenser',2.45,.66,-6.25,.65,1.27,.67,white,.045)
cube('Water dispenser controls',2.45,.91,-5.90,.48,.35,.03,black,.012)
cyl('Bottle neck',2.45,1.38,-6.25,.12,.25,water)
cyl('Water bottle shoulder',2.45,1.56,-6.25,.27,.2,water,32,.12)
cyl('Water bottle main',2.45,1.87,-6.25,.27,.45,water,32)
for y in [1.68,1.78,1.93,2.04]: cyl('Water bottle rib',2.45,y,-6.25,.281,.024,water,32)
for x in [2.32,2.59]: rod('Dispenser tap',(x,.94,-5.88),(x,.94,-5.79),.022,steel)
cube('Water tray',2.45,.66,-5.83,.44,.035,.22,black,.01)

def plant(x,z,s=1):
    cyl('Ceramic planter',x,.36*s,z,.34*s,.7*s,pot,32,.25*s)
    cyl('Visible potting soil',x,.713*s,z,.31*s,.014,soil,24)
    for branch in range(4):
        ang=branch*2.4
        height=(1.2+branch*.21)*s
        bx=x+math.cos(ang)*.24*s
        bz=z+math.sin(ang)*.24*s
        rod('Ficus branch',(x,.6*s,z),(bx,height,bz),.018*s,walnut,8)
        for k in range(6):
            a=ang+k*2.2
            bpy.ops.mesh.primitive_uv_sphere_add(segments=10,ring_count=6,location=(bx+math.cos(a)*.21*s,-bz-math.sin(a)*.21*s,height-(k%3)*.15*s))
            o=bpy.context.object
            o.name='Ficus lanceolate leaf'
            o.scale=(.27*s,.095*s,.028*s)
            o.rotation_euler=(math.sin(a)*.6,math.cos(a)*.4,a)
            o.data.materials.append(leafA if k%2 else leafB)
for x,z,s in [(-9.5,-7.3,1.35),(-2.7,-7.5,1.15),(9.5,-7.2,1.5),(9.6,-.5,1.35),(-9.5,6.9,1.25)]: plant(x,z,s)

# Suspended corporate linear lights, with thin cable supports.
for x,z,w in [(-6.2,-5.1,3.6),(-5.8,.7,3),(-.7,.7,3),(-5.8,4.4,3),(-.7,4.4,3),(6,-4.4,2.8)]:
    cube('Suspended architectural light',x,3.55,z,w,.075,.15,black,.01)
    cube('LED luminous underside',x,3.508,z,w-.07,.008,.105,light)
    for dx in [-w*.35,w*.35]: rod('Light suspension cable',(x+dx,3.59,z),(x+dx,4.1,z),.004,steel,6)

# Structural columns and entrance reception storage.
for x,z in [(-10.3,-8.3),(10.25,-8.3),(10.25,1.0)]:
    cube('Concrete structural column',x,2.08,z,.43,4.16,.43,white,.018)
cube('Entry credenza',8.5,.55,4.3,1.2,1.0,2.8,walnut,.018)
cube('Entry stone top',8.5,1.09,4.3,1.26,.09,2.86,stone,.012)
for z in [3.4,4.3,5.2]:
    cube('Entry cabinet front',7.88,.56,z,.028,.9,.85,walnutLight,.005)
    rod('Entry cabinet handle',(7.85,.53,z-.09),(7.85,.53,z+.09),.01,steel,8)
cube('Arrival floor mat',6.1,.046,6.2,4.4,.02,2.1,carpet)

# Export the actual geometry. Apply bevels to guarantee matching browser appearance.
for o in list(bpy.context.scene.objects):
    if o.type=='MESH':
        bpy.context.view_layer.objects.active=o
        for modifier in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "assets/fourteenth-office.blend"))
bpy.ops.export_scene.gltf(filepath=str(ROOT / "public/models/office-shell.glb"),export_format='GLB',export_apply=True,export_lights=False,export_cameras=False)

# A standalone inspection render from the actual scene.
bpy.ops.object.camera_add(location=(25,-30,25))
camera=bpy.context.object
direction=Vector((0,0,1))-camera.location
camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO'
camera.data.ortho_scale=32
bpy.context.scene.camera=camera
bpy.ops.object.light_add(type='AREA',location=(-5,2,20))
bpy.context.object.data.energy=3500
bpy.context.object.data.shape='DISK'
bpy.context.object.data.size=15
bpy.context.scene.world.color=(.5,.5,.5)
bpy.context.scene.render.engine='CYCLES'
bpy.context.scene.cycles.samples=24
bpy.context.scene.render.resolution_x=1400
bpy.context.scene.render.resolution_y=1000
bpy.context.scene.render.resolution_percentage=100
bpy.context.scene.render.image_settings.file_format='PNG'
bpy.context.scene.render.filepath=str(ROOT / "assets/blender-office-review.png")
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / "assets/fourteenth-office.blend"))
print('OFFICE_EXPORT_COMPLETE',len(bpy.context.scene.objects),'objects')
