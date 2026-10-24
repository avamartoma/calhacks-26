import * as THREE from 'three';
import type { SharedOffice } from './types';
import { CityEnvironment } from './CityEnvironment';
import { MAX_TEAMMATES, officePosition } from './office-layout';

/** Shared building instances; only the selected office gets desks and agents. */
export class TeamDistrict {
  root = new THREE.Group();
  buildings: THREE.InstancedMesh;
  floors: THREE.InstancedMesh;
  slabs: THREE.InstancedMesh;
  bridges: THREE.InstancedMesh;
  labels = new THREE.Group();
  offices: SharedOffice[] = [];
  private signature = '';
  constructor(private city: CityEnvironment) {
    const geometry = new THREE.BoxGeometry(1,1,1);
    const sizes = new Float32Array(MAX_TEAMMATES*3);
    for(let i=0;i<MAX_TEAMMATES;i++)sizes.set([21.6,43.65,17.6],i*3);
    geometry.setAttribute('citySize',new THREE.InstancedBufferAttribute(sizes,3));
    this.buildings = new THREE.InstancedMesh(geometry,city.facadeMaterial(),MAX_TEAMMATES);
    this.floors = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:'#748f91',roughness:.4,metalness:.3}),MAX_TEAMMATES);
    this.slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:'#dce2d9',roughness:.8}),MAX_TEAMMATES);
    this.bridges = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({color:'#b6c4bb',roughness:.7}),MAX_TEAMMATES);
    for(const mesh of [this.buildings,this.floors,this.slabs,this.bridges]){
      (mesh.material as THREE.MeshStandardMaterial).fog=false;
      mesh.count=0;mesh.castShadow=true;mesh.receiveShadow=true;mesh.frustumCulled=false;this.root.add(mesh);
    }
    this.root.add(this.labels);
  }
  update(offices: SharedOffice[], selectedId?: string) {
    const next=offices.slice(0,MAX_TEAMMATES);
    const signature=JSON.stringify([selectedId,next.map(o=>[o.id,o.owner,o.name,o.agents.length])]);
    if(signature===this.signature)return;
    this.signature=signature;this.offices=next;this.clearLabels();
    this.city.setOfficeLots(next.map((_,i)=>officePosition(i)));
    const dummy=new THREE.Object3D();
    const put=(mesh:THREE.InstancedMesh,i:number,x:number,y:number,z:number,w:number,h:number,d:number)=>{
      dummy.position.set(x,y,z);dummy.scale.set(w,h,d);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);
    };
    next.forEach((office,i)=>{
      const {x,z}=officePosition(i), selected=office.id===selectedId;
      put(this.buildings,i,x,-22.175,z,21.6,43.65,17.6);
      this.buildings.setColorAt(i,new THREE.Color(selected?'#acbcb4':'#869ba0'));
      put(this.floors,i,x,2,z,selected?0:21.6,selected?0:4,selected?0:17.6);
      put(this.slabs,i,x,-.25,z,22,.25,18);
      // Every lot connects horizontally or vertically to the central block grid.
      if(x!==0)put(this.bridges,i,x/2,-.22,z,28,.3,3);
      else put(this.bridges,i,0,-.22,z/2,3,.3,32);
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=112;
      const context=canvas.getContext('2d')!;
      context.fillStyle=selected?'#244a3d':'#f5f7f2';context.fillRect(0,0,512,112);
      context.fillStyle=selected?'#f5f7f2':'#294536';context.font='bold 28px sans-serif';context.fillText(office.owner,18,42);
      context.font='22px sans-serif';context.fillText(`${office.agents.length} agents · ${office.name}`.slice(0,43),18,82);
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
      const label=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:true,fog:false}));
      label.position.set(x,9,z);label.scale.set(19,4.16,1);label.userData.officeId=office.id;this.labels.add(label);
    });
    for(const mesh of [this.buildings,this.floors,this.slabs,this.bridges]){
      mesh.count=next.length;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;
      mesh.computeBoundingSphere();mesh.computeBoundingBox();
    }
  }
  hit(ray: THREE.Raycaster) {
    const hits=ray.intersectObjects([this.buildings,this.floors,this.slabs,...this.labels.children],false);
    const hit=hits[0];if(!hit)return;
    return hit.object.userData.officeId as string || (hit.instanceId===undefined?undefined:this.offices[hit.instanceId]?.id);
  }
  private clearLabels() {
    for(const object of this.labels.children){const sprite=object as THREE.Sprite;sprite.material.map?.dispose();sprite.material.dispose();}this.labels.clear();
  }
  dispose() {
    this.clearLabels();
    for(const mesh of [this.buildings,this.floors,this.slabs,this.bridges]){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();mesh.dispose();}
    this.root.removeFromParent();
  }
}
