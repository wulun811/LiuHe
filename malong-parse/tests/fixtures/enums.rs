// Rust enums example

#[derive(Debug, Clone)]
enum Color {
    Red,
    Green,
    Blue,
    Custom(u8, u8, u8),
}

#[derive(Debug)]
enum Shape {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
    Triangle { base: f64, height: f64 },
}

impl Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle { radius } => std::f64::consts::PI * radius * radius,
            Shape::Rectangle { width, height } => width * height,
            Shape::Triangle { base, height } => 0.5 * base * height,
        }
    }
}

fn describe_color(color: &Color) -> String {
    match color {
        Color::Red => "Red".to_string(),
        Color::Green => "Green".to_string(),
        Color::Blue => "Blue".to_string(),
        Color::Custom(r, g, b) => format!("Custom({}, {}, {})", r, g, b),
    }
}

fn main() {
    let circle = Shape::Circle { radius: 5.0 };
    println!("Circle area: {}", circle.area());
    
    let color = Color::Custom(255, 128, 0);
    println!("Color: {}", describe_color(&color));
}
