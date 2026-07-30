import functools

def log_call(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        print(f"calling {func.__name__}")
        return func(*args, **kwargs)
    return wrapper

@log_call
def hello(name):
    return f"Hello, {name}"

class Calculator:
    def __init__(self):
        self.total = 0
    
    def add(self, x):
        self.total += x
        return self
    
    def result(self):
        return self.total
