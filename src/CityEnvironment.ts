import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

type Block = { x:number; z:number; w:number; d:number; h:number; y:number; color:string };
const GROUND = -44;

/** A continuous, seeded city in the same metre-scale world as the office. */
export class CityEnvironment {
  root = new THREE.Group();
  sky = new Sky();
  environment: THREE.WebGLRenderTarget;
  traffic: THREE.InstancedMesh;
  cars: { lane:number; offset:number; horizontal:boolean; direction:number; speed:number }[] = [];
  waterTime = { value:0 };
  dummy = new THREE.Object3D();
  count = 0;
  private originalInstances = new Map<THREE.InstancedMesh, Float32Array>();
  private officeLotsKey = '';

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.root.name = 'Fourteenth city district';
    scene.add(this.root);
    this.sky.scale.setScalar(2400);
    const sun = new THREE.Vector3(-.6,.48,-.5).normalize();
    this.sky.material.uniforms.sunPosition.value.copy(sun);
    this.sky.material.uniforms.turbidity.value = 2.9;
    this.sky.material.uniforms.rayleigh.value = 1.35;
    this.sky.material.uniforms.mieCoefficient.value = .004;
    this.sky.material.uniforms.mieDirectionalG.value = .82;
    this.root.add(this.sky);
    const skyScene = new THREE.Scene();
    const reflectionSky = this.sky.clone(); skyScene.add(reflectionSky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(skyScene, .02, .1, 3000);
    pmrem.dispose();
    scene.environment = this.environment.texture;
    scene.environmentIntensity = .72;
    scene.fog = new THREE.Fog('#c9d4da', 95, 520);

    let seed=1400926;
    const random=()=> { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
    const blocks:Block[]=[], roofs:Block[]=[], trim:Block[]=[], greens:Block[]=[];
    const palette=['#b9cbd2','#b6c6c8','#d8d4c6','#cdd0c8','#8eabb6','#e6e1d2'];
    const building=(x:number,z:number,w:number,d:number,h:number,style:number)=>{
      const color=palette[style%palette.length];
      blocks.push({x,z,w,d,h,y:GROUND+h/2,color});
      this.count++;
      // Occupied towers have roof slabs, service cores, parapets, and ventilation.
      roofs.push({x,z,w:w+.35,d:d+.35,h:.35,y:GROUND+h+.18,color:'#a9aaa3'});
      if(h>32){
        roofs.push({x:x+w*.13,z:z-d*.15,w:w*.3,d:d*.25,h:2.4,y:GROUND+h+1.55,color:'#79888a'});
        roofs.push({x:x-w*.22,z:z+d*.18,w:2.2,d:3.3,h:1.1,y:GROUND+h+.9,color:'#b2b6b0'});
      }
      for(const side of [-1,1]) {
        trim.push({x:x+side*w/2,z,w:.12,d,h:.8,y:GROUND+h+.6,color:'#d1cfc4'});
        trim.push({x,z:z+side*d/2,w,d:.12,h:.8,y:GROUND+h+.6,color:'#d1cfc4'});
      }
      if(style%3===0) for(let y=12;y<h-2;y+=12.4) {
        trim.push({x,z,w:w+.18,d:d+.18,h:.13,y:GROUND+y,color:'#c6c8bd'});
      }
    };
    // The office is a genuine part of the city, with its occupied floor at y=0.
    blocks.push({x:0,z:0,w:21.6,d:17.6,h:43.65,y:GROUND+43.65/2,color:'#aec2c9'});
    this.count++;
    for(let bx=-6;bx<=6;bx++) for(let bz=-6;bz<=6;bz++) {
      if(bx===0&&bz===0)continue;
      const x=bx*50,z=bz*50;
      // Keep a river and its promenade continuous through the eastern district.
      if(bx===4)continue;
      if((bx===-1&&bz===0)||(bx===0&&bz===1)) {
        greens.push({x,z,w:34,d:34,h:.12,y:GROUND+.13,color:'#71836b'});
        continue;
      }
      const dist=Math.hypot(x,z), style=Math.floor(random()*6);
      let h=22+random()*45;
      if(bz<0 && dist<180) h+=20+random()*30;
      if(dist<90) h=Math.min(h,54);
      // Lower blocks on the near side keep the architectural cutaway legible.
      if(bz>=0&&bx>=0&&dist<130)h=Math.min(h,28);
      if(dist>230)h*=.65;
      if(style%2===0) {
        const w=16+random()*8,d=17+random()*8;
        building(x-5,z-4,w,d,h,style);
        building(x+12,z+12,9,11,12+random()*16,style+1);
      } else {
        building(x-9,z,12,27,h*.7,style);
        building(x+9,z-5,12,17,h,style+2);
      }
      // Setbacks make silhouettes read as architecture instead of a box field.
      if(h>68&&style%2===0) {
        blocks.push({x:x-5,z:z-4,w:11,d:12,h:8,y:GROUND+h+4,color:palette[style]});
        roofs.push({x:x-5,z:z-4,w:11.2,d:12.2,h:.4,y:GROUND+h+8.2,color:'#9caaa8'});
      }
    }
    this.instances(blocks,this.facadeMaterial());
    this.instances(roofs,new THREE.MeshStandardMaterial({roughness:.86,metalness:.12}));
    this.instances(trim,new THREE.MeshStandardMaterial({roughness:.48,metalness:.35}));
    this.instances(greens,new THREE.MeshStandardMaterial({roughness:1}));
    const paths:Block[]=[];
    for(const park of greens){
      paths.push({...park,w:3,h:.08,y:GROUND+.24,color:'#b2b0a1'},{...park,d:3,h:.08,y:GROUND+.24,color:'#b2b0a1'});
    }
    this.instances(paths,new THREE.MeshStandardMaterial({roughness:.9}));
    this.makeGround();

    // Street trees: varied overlapping crowns, dark trunks, no floating sprites.
    const crowns:Block[]=[], trunks:Block[]=[];
    for(let bx=-3;bx<=3;bx++)for(let bz=-3;bz<=3;bz++){
      if(bx===0&&bz===0)continue;
      for(let i=0;i<4;i++) {
        const x=bx*50-18+i*11,z=bz*50+19;
        trunks.push({x,z,w:.22,d:.22,h:3.4,y:GROUND+1.7,color:'#635d4a'});
        crowns.push({x,z,w:3.6+random(),d:3.6,h:4+random(),y:GROUND+4.1,color:random()>.5?'#63765a':'#788267'});
      }
    }
    this.instances(trunks,new THREE.MeshStandardMaterial({roughness:1}));
    this.instances(crowns,new THREE.MeshStandardMaterial({roughness:1}),new THREE.IcosahedronGeometry(.5,1));

    // Slow street traffic gives scale without distracting from active agents.
    this.traffic = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({roughness:.35,metalness:.45}),72);
    this.traffic.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for(let i=0;i<72;i++){
      this.cars.push({lane:(Math.floor(random()*7)-3)*50+25,offset:random()*600,horizontal:i%2===0,direction:i%3===0?-1:1,speed:5+random()*5});
      this.traffic.setColorAt(i,new THREE.Color(['#d8d6ca','#414b50','#b5aa84','#6c868d'][i%4]));
    }
    this.traffic.castShadow=true;this.traffic.frustumCulled=false;this.root.add(this.traffic);
    this.update(0,false);
    renderer.domElement.dataset.skyline='procedural-3d-city';
    renderer.domElement.dataset.cityBuildings=String(this.count);
  }

  instances(items:Block[],material:THREE.MeshStandardMaterial,geometry:THREE.BufferGeometry=new THREE.BoxGeometry(1,1,1)) {
    const mesh=new THREE.InstancedMesh(geometry,material,items.length);
    const sizes=new Float32Array(items.length*3);
    for(const [i,b] of items.entries()) {
      this.dummy.position.set(b.x,b.y,b.z);this.dummy.rotation.set(0,0,0);this.dummy.scale.set(b.w,b.h,b.d);this.dummy.updateMatrix();
      mesh.setMatrixAt(i,this.dummy.matrix);mesh.setColorAt(i,new THREE.Color(b.color));sizes.set([b.w,b.h,b.d],i*3);
    }
    geometry.setAttribute('citySize',new THREE.InstancedBufferAttribute(sizes,3));
    mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingSphere();this.root.add(mesh);return mesh;
  }

  facadeMaterial() {
    const material=new THREE.MeshStandardMaterial({roughness:.32,metalness:.45});
    material.onBeforeCompile=shader=>{
      shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>
        attribute vec3 citySize;
        varying vec3 vCityPosition;
        varying vec3 vCityNormal;
        varying float vCitySeed;`);
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        vCityPosition=(position+0.5)*citySize;
        vCityNormal=normal;
        vCitySeed=instanceMatrix[3].x*.17+instanceMatrix[3].z*.31;`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec3 vCityPosition;
        varying vec3 vCityNormal;
        varying float vCitySeed;
        float cityHash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        vec2 facade=abs(vCityNormal.z)>.5?vCityPosition.xy:vCityPosition.zy;
        vec2 cell=facade/vec2(1.55,3.1);
        vec2 pane=fract(cell);
        vec2 aa=max(fwidth(cell),vec2(.006));
        // Keep the per-building hash stable across interpolated fragments.
        // Tiny interpolation errors otherwise become visible facade speckling.
        float buildingSeed=floor(vCitySeed+.5);
        float masonry=step(.66,cityHash(vec2(buildingSeed,3.7)));
        float frame=mix(.014,.095,masonry);
        float glass=smoothstep(frame,frame+aa.x,pane.x)*(1.-smoothstep(1.-frame-aa.x,1.-frame,pane.x));
        glass*=smoothstep(mix(.025,.18,masonry),mix(.025,.18,masonry)+aa.y,pane.y)*(1.-smoothstep(.97-aa.y,.97,pane.y));
        glass*=1.-step(.5,abs(vCityNormal.y));
        float room=cityHash(floor(cell)+buildingSeed);
        float blinds=step(.74,room)*smoothstep(.28,.31,pane.y);
        float lit=step(.93,room)*glass;
        vec3 glassTint=mix(vec3(.3,.44,.52),vec3(.48,.6,.66),room);
        glassTint=mix(glassTint,vec3(.62,.59,.51),blinds*.32);
        float spandrel=1.-smoothstep(.17,.19,pane.y);
        glassTint*=1.-spandrel*.3*(1.-masonry);
        float insetShadow=smoothstep(frame,frame+.1,pane.x)*smoothstep(.18,.27,pane.y);
        glassTint*=mix(1.,.68+.32*insetShadow,masonry);
        diffuseColor.rgb*=mix(mix(vec3(.68),vec3(.92,.88,.8),masonry),glassTint,glass);
        totalEmissiveRadiance+=vec3(1.,.68,.34)*lit*.22;`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(.64,.22,glass);');
      shader.fragmentShader=shader.fragmentShader.replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=mix(.16,.48,glass);');
    };
    material.customProgramCacheKey=()=> 'fourteenth-city-facade-v3';
    return material;
  }

  setOfficeLots(lots: {x:number;z:number}[]) {
    const key=JSON.stringify(lots);if(key===this.officeLotsKey)return;this.officeLotsKey=key;
    // Replace occupied city blocks instead of intersecting the procedural skyline.
    this.root.traverse(object=>{
      if(!(object instanceof THREE.InstancedMesh) || object===this.traffic)return;
      if(!this.originalInstances.has(object))this.originalInstances.set(object,new Float32Array(object.instanceMatrix.array));
      const original=this.originalInstances.get(object)!;
      const matrix=new THREE.Matrix4();
      for(let i=0;i<object.count;i++){
        matrix.fromArray(original,i*16);
        if(lots.some(lot=>Math.abs(matrix.elements[12]-lot.x)<24 && Math.abs(matrix.elements[14]-lot.z)<24))matrix.scale(new THREE.Vector3(0,0,0));
        object.setMatrixAt(i,matrix);
      }
      object.instanceMatrix.needsUpdate=true;
    });
  }

  makeGround() {
    const groundMaterial=new THREE.MeshStandardMaterial({color:'#b7b6a6',roughness:.96});
    groundMaterial.onBeforeCompile=shader=>{
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vStreet;');
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvStreet=(modelMatrix*vec4(position,1.)).xyz;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vStreet;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        vec2 lane=abs(mod(vStreet.xz,50.)-25.);
        float road=1.-smoothstep(4.5,4.7,min(lane.x,lane.y));
        float curb=1.-smoothstep(6.5,6.7,min(lane.x,lane.y));
        vec3 surface=mix(vec3(.5,.51,.45),vec3(.72,.72,.64),curb);
        surface=mix(surface,vec3(.26,.3,.32),road);
        float dashX=(1.-smoothstep(.045,.12,lane.x))*step(.48,fract(vStreet.z*.12));
        float dashZ=(1.-smoothstep(.045,.12,lane.y))*step(.48,fract(vStreet.x*.12));
        surface=mix(surface,vec3(.75,.72,.53),max(dashX,dashZ)*road*.8);
        float crossingX=step(4.8,lane.x)*(1.-step(7.2,lane.x))*(1.-step(4.,lane.y));
        float crossingZ=step(4.8,lane.y)*(1.-step(7.2,lane.y))*(1.-step(4.,lane.x));
        float zebra=max(crossingX*step(.5,fract(vStreet.z)),crossingZ*step(.5,fract(vStreet.x)));
        diffuseColor.rgb=surface+zebra*.18;`);
    };
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(1500,1500),groundMaterial);ground.rotation.x=-Math.PI/2;ground.position.y=GROUND-.05;ground.updateMatrixWorld();ground.receiveShadow=true;this.root.add(ground);
    const water=new THREE.Mesh(new THREE.PlaneGeometry(32,900),new THREE.MeshStandardMaterial({color:'#557c85',roughness:.2,metalness:.65}));
    water.rotation.x=-Math.PI/2;water.position.set(200,GROUND+.03,0);this.root.add(water);
    const waterMaterial=water.material;
    waterMaterial.onBeforeCompile=shader=>{
      shader.uniforms.cityTime=this.waterTime;
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform float cityTime;');
      shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        normal.x+=sin(vViewPosition.x*.45+cityTime*.3)*.055;
        normal.z+=cos(vViewPosition.z*.65+cityTime*.21)*.055;
        normal=normalize(normal);`);
    };
    const bridges:Block[]=[];
    for(let z=-275;z<=275;z+=50){
      bridges.push({x:200,z,w:34,d:10,h:.35,y:GROUND+.2,color:'#647273'});
      for(const side of [-1,1]) bridges.push({x:200,z:z+side*5,w:34,d:.18,h:.8,y:GROUND+.72,color:'#afb5ac'});
    }
    this.instances(bridges,new THREE.MeshStandardMaterial({roughness:.8}));
  }

  update(time:number,reduced:boolean) {
    const t=reduced?0:time;this.waterTime.value=t;
    this.cars.forEach((car,i)=>{
      const position=((car.offset+t*car.speed)%600)-300;
      const lane=car.lane+car.direction*2.1;
      this.dummy.position.set(car.horizontal?position*car.direction:lane,GROUND+.55,car.horizontal?lane:position*car.direction);
      this.dummy.rotation.set(0,car.horizontal?Math.PI/2:0,0);this.dummy.scale.set(1.65,1,3.7);this.dummy.updateMatrix();this.traffic.setMatrixAt(i,this.dummy.matrix);
    });
    this.traffic.instanceMatrix.needsUpdate=true;
  }

  bakeReflections(renderer:THREE.WebGLRenderer,scene:THREE.Scene) {
    // A one-time local probe captures actual neighbouring geometry and lighting.
    const target=new THREE.WebGLCubeRenderTarget(256,{type:THREE.HalfFloatType});
    const probe=new THREE.CubeCamera(.5,1500,target);probe.position.set(0,3,0);
    probe.update(renderer,scene);
    const generator=new THREE.PMREMGenerator(renderer);
    const captured=generator.fromCubemap(target.texture);
    this.environment.dispose();this.environment=captured;
    scene.environment=captured.texture;scene.environmentIntensity=.85;
    generator.dispose();target.dispose();
  }

  dispose() {
    const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
    this.root.traverse(o=>{const m=o as THREE.Mesh;if(m.geometry)geometries.add(m.geometry);if(m.material)for(const mat of Array.isArray(m.material)?m.material:[m.material])materials.add(mat);if(o instanceof THREE.InstancedMesh)o.dispose();});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.environment.dispose();this.root.removeFromParent();
  }
}
