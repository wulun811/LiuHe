trait Drawable {
    fn draw(&self) -> String;
}

struct Circle {
    radius: f64,
}

struct Square {
    side: f64,
}

impl Drawable for Circle {
    fn draw(&self) -> String {
        format!("Circle(r={})", self.radius)
    }
}

impl Drawable for Square {
    fn draw(&self) -> String {
        format!("Square(s={})", self.side)
    }
}

fn render(items: Vec<Box<dyn Drawable>>) -> Vec<String> {
    items.iter().map(|item| item.draw()).collect()
}
