use super::{layout::{Layout,V3},scene::{Camera,Frame,Hit},style::Palette};
impl Frame{
    pub(super) fn district(&mut self,c:&Camera,l:&Layout,p:Palette,selected:Option<usize>,compact:bool){
        for b in &l.buildings{
            let x=b.center.x;let z=b.center.z;let w=l.width;let d=l.depth;
            self.cuboid(c,V3::new(x,-28.,z),w+240.,12.,d+240.,p.line,None);
            if compact{continue;}
            // Every parcel owns its east and south street strips; adjacent parcels meet exactly.
            self.cuboid(c,V3::new(x+w/2.+200.,-30.,z+80.),160.,4.,d+400.,p.muted,None);
            self.cuboid(c,V3::new(x+80.,-30.,z+d/2.+200.),w+400.,4.,160.,p.muted,None);
            for n in 0..8{let t=(n as f32+0.5)/8.;self.cuboid(c,V3::new(x-w/2.+t*(w+240.),-25.,z+d/2.+200.),30.,1.,4.,p.surface,None);}
            // The entrance always faces the south street across the pavement setback.
            for step in 0..3{self.cuboid(c,V3::new(x,-12.+step as f32*4.,z+d/2.+65.-step as f32*18.),120.,4.,40.,p.edge,None);}
            self.cuboid(c,V3::new(x,0.,z+d/2.+15.),130.,12.,48.,p.accent,None);
            for dx in [-64.,64.]{self.cuboid(c,V3::new(x+dx,0.,z+d/2.+15.),8.,100.,8.,p.edge,None);}
            self.cuboid(c,V3::new(x,100.,z+d/2.+15.),150.,8.,60.,p.line,None);
            for side in [-1.,1.]{
                let tx=x+side*(w/2.+65.);let tz=z+d/2.+65.;
                self.cuboid(c,V3::new(tx,-14.,tz),32.,12.,32.,p.edge,None);
                self.cuboid(c,V3::new(tx,-2.,tz),8.,74.,8.,p.warning,None);
                self.cuboid(c,V3::new(tx,55.,tz),55.,38.,48.,p.active,None);
                self.cuboid(c,V3::new(tx+side*25.,-14.,z-d/2.-65.),6.,110.,6.,p.edge,None);
                self.cuboid(c,V3::new(tx+side*25.,96.,z-d/2.-65.),26.,8.,26.,p.warning,None);
            }
        }
        for (i,f)in l.floors.iter().enumerate(){
            if selected.is_some_and(|j|j!=i){continue;}let b=&l.buildings[f.building];let x=b.center.x;let z=b.center.z;let y=f.y;let w=l.width;let d=l.depth;let hit=Some(Hit::Floor(i));
            self.cuboid(c,V3::new(x,y-12.,z),w,12.,d,if f.unresolved{p.warning}else{p.selected},hit);
            if compact{continue;}
            for dx in [-w/2.,w/2.]{for dz in [-d/2.,d/2.]{self.cuboid(c,V3::new(x+dx,y,z+dz),12.,205.,12.,p.edge,hit);}}
            // Open front and roof keep employees selectable; back and side facades have real window panes.
            for dz in [-d/2.,d/2.]{self.cuboid(c,V3::new(x,y+195.,z+dz),w,10.,12.,p.line,hit);}
            for dx in [-w/2.,w/2.]{self.cuboid(c,V3::new(x+dx,y+195.,z),12.,10.,d,p.line,hit);}
            for n in 0..6{let wx=x-w/2.+(n as f32+0.5)*w/6.;self.cuboid(c,V3::new(wx,y+65.,z-d/2.),w/6.-16.,75.,3.,p.surface,hit);self.cuboid(c,V3::new(wx-w/12.,y+5.,z-d/2.),6.,190.,6.,p.edge,hit);}
            for n in 0..3{let wz=z-d/2.+(n as f32+0.5)*d/3.;self.cuboid(c,V3::new(x-w/2.,y+65.,wz),3.,75.,d/3.-20.,p.surface,hit);}
            // Main office zone remains separate from shared workstations.
            self.cuboid(c,V3::new(x-w/2.+245.,y+2.,z),5.,65.,d-50.,p.line,hit);
            self.cuboid(c,V3::new(x-w/2.+120.,y+3.,z-d/2.+30.),210.,8.,30.,p.accent,hit);
        }
    }
    pub(super) fn employee(&mut self,c:&Camera,p:V3,color:u32,palette:Palette,index:usize){
        let hit=Some(Hit::Node(index));
        // Desk, four legs, monitor and keyboard are independent from chair and employee.
        self.cuboid(c,V3::new(p.x,p.y-13.,p.z+35.),78.,6.,44.,palette.line,hit);
        for dx in [-32.,32.]{for dz in [18.,52.]{self.cuboid(c,V3::new(p.x+dx,p.y-40.,p.z+dz),4.,27.,4.,palette.edge,hit);}}
        self.cuboid(c,V3::new(p.x,p.y-7.,p.z+48.),5.,12.,5.,palette.edge,hit);
        self.cuboid(c,V3::new(p.x,p.y+5.,p.z+48.),32.,23.,4.,palette.accent,hit);
        self.cuboid(c,V3::new(p.x,p.y-6.,p.z+25.),28.,2.,12.,palette.muted,hit);
        self.cuboid(c,V3::new(p.x,p.y-22.,p.z-8.),28.,5.,26.,palette.edge,hit);
        self.cuboid(c,V3::new(p.x,p.y-17.,p.z-21.),28.,28.,5.,palette.muted,hit);
        self.cuboid(c,V3::new(p.x,p.y-40.,p.z-8.),5.,18.,5.,palette.edge,hit);
        self.cuboid(c,V3::new(p.x,p.y-40.,p.z-8.),34.,3.,5.,palette.edge,hit);
        self.cuboid(c,V3::new(p.x,p.y-17.,p.z),23.,30.,18.,color,hit);
        self.cuboid(c,V3::new(p.x,p.y+15.,p.z),18.,18.,18.,palette.muted,hit);
        for dx in [-15.,15.]{self.cuboid(c,V3::new(p.x+dx,p.y-7.,p.z+9.),7.,8.,25.,color,hit);}
        for dx in [-7.,7.]{self.cuboid(c,V3::new(p.x+dx,p.y-35.,p.z+5.),8.,18.,8.,palette.edge,hit);}
    }
}
