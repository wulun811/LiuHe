use std::fmt;

#[derive(Debug)]
enum AppError {
    NotFound(String),
    PermissionDenied,
    Internal(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            AppError::NotFound(msg) => write!(f, "Not found: {}", msg),
            AppError::PermissionDenied => write!(f, "Permission denied"),
            AppError::Internal(msg) => write!(f, "Internal: {}", msg),
        }
    }
}

fn find_user(id: u32) -> Result<String, AppError> {
    if id == 0 {
        Err(AppError::NotFound(format!("user {}", id)))
    } else {
        Ok(format!("User {}", id))
    }
}

fn process() -> Result<(), AppError> {
    let user = find_user(42)?;
    println!("{}", user);
    Ok(())
}
