// Rust traits example

trait Drawable {
    fn draw(&self) -> String;
}

trait Resizable {
    fn resize(&mut self, factor: f64);
}

struct Point {
    x: f64,
    y: f64,
}

impl Drawable for Point {
    fn draw(&self) -> String {
        format!("Point at ({}, {})", self.x, self.y)
    }
}

struct Line {
    start: Point,
    end: Point,
}

impl Drawable for Line {
    fn draw(&self) -> String {
        format!("Line from ({}, {}) to ({}, {})", 
            self.start.x, self.start.y, self.end.x, self.end.y)
    }
}

impl Resizable for Line {
    fn resize(&mut self, factor: f64) {
        self.end.x = self.start.x + (self.end.x - self.start.x) * factor;
        self.end.y = self.start.y + (self.end.y - self.start.y) * factor;
    }
}

fn print_drawable(item: &dyn Drawable) {
    println!("{}", item.draw());
}

fn main() {
    let p = Point { x: 1.0, y: 2.0 };
    let mut l = Line { 
        start: Point { x: 0.0, y: 0.0 }, 
        end: Point { x: 10.0, y: 10.0 } 
    };
    
    print_drawable(&p);
    print_drawable(&l);
    
    l.resize(2.0);
    print_drawable(&l);
}
