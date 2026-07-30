// Rust struct methods example

struct Rectangle {
    width: f64,
    height: f64,
}

impl Rectangle {
    // Constructor
    fn new(width: f64, height: f64) -> Self {
        Rectangle { width, height }
    }
    
    // Associated function
    fn square(size: f64) -> Self {
        Rectangle { width: size, height: size }
    }
    
    // Method
    fn area(&self) -> f64 {
        self.width * self.height
    }
    
    // Method with mutation
    fn scale(&mut self, factor: f64) {
        self.width *= factor;
        self.height *= factor;
    }
    
    // Method that consumes self
    fn into_string(self) -> String {
        format!("Rectangle({} x {})", self.width, self.height)
    }
    
    // Static method
    fn is_valid(width: f64, height: f64) -> bool {
        width > 0.0 && height > 0.0
    }
}

struct Circle {
    radius: f64,
}

impl Circle {
    fn new(radius: f64) -> Self {
        Circle { radius }
    }
    
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }
    
    fn circumference(&self) -> f64 {
        2.0 * std::f64::consts::PI * self.radius
    }
}

fn main() {
    let mut rect = Rectangle::new(10.0, 5.0);
    println!("Area: {}", rect.area());
    
    rect.scale(2.0);
    println!("Scaled area: {}", rect.area());
    
    let circle = Circle::new(5.0);
    println!("Circle area: {}", circle.area());
}
