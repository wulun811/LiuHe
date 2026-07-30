// Rust pattern matching example

fn classify_number(n: i32) -> &'static str {
    match n {
        0 => "zero",
        1..=9 => "single digit",
        10..=99 => "double digit",
        100..=999 => "triple digit",
        _ => "too big",
    }
}

fn describe_option(opt: Option<i32>) -> String {
    match opt {
        Some(x) if x > 0 => format!("positive: {}", x),
        Some(x) if x < 0 => format!("negative: {}", x),
        Some(0) => "zero".to_string(),
        None => "nothing".to_string(),
        _ => unreachable!(),
    }
}

enum Command {
    Quit,
    Echo(String),
    Move { x: i32, y: i32 },
    ChangeColor(i32, i32, i32),
}

fn process_command(cmd: Command) -> String {
    match cmd {
        Command::Quit => "Quitting".to_string(),
        Command::Echo(msg) => msg,
        Command::Move { x, y } => format!("Moving to ({}, {})", x, y),
        Command::ChangeColor(r, g, b) => format!("Color: ({}, {}, {})", r, g, b),
    }
}

fn main() {
    println!("{}", classify_number(42));
    println!("{}", describe_option(Some(10)));
    println!("{}", process_command(Command::Move { x: 10, y: 20 }));
}
