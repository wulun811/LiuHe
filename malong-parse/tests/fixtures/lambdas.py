# Python lambda and closure example

def make_multiplier(factor):
    """Returns a function that multiplies by factor."""
    return lambda x: x * factor

def counter():
    """Closure example with state."""
    count = 0
    def increment():
        nonlocal count
        count += 1
        return count
    return increment

def compose(f, g):
    """Function composition."""
    return lambda x: f(g(x))

# Higher-order functions
def apply_twice(f, x):
    return f(f(x))

def map_filter_reduce(numbers):
    # Map
    doubled = list(map(lambda x: x * 2, numbers))
    
    # Filter
    evens = list(filter(lambda x: x % 2 == 0, numbers))
    
    # Reduce (using functools)
    from functools import reduce
    total = reduce(lambda a, b: a + b, numbers, 0)
    
    return doubled, evens, total

# Decorator factory
def repeat(n):
    def decorator(func):
        def wrapper(*args, **kwargs):
            for _ in range(n):
                result = func(*args, **kwargs)
            return result
        return wrapper
    return decorator

@repeat(3)
def greet(name):
    print(f"Hello, {name}!")
