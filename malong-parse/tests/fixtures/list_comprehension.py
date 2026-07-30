# Python list comprehension example

def process_list(numbers):
    # List comprehension
    squares = [x**2 for x in numbers]
    
    # Filtered list comprehension
    evens = [x for x in numbers if x % 2 == 0]
    
    # Nested list comprehension
    matrix = [[i*j for j in range(1, 4)] for i in range(1, 4)]
    
    # Dict comprehension
    square_dict = {x: x**2 for x in numbers}
    
    # Set comprehension
    unique_squares = {x**2 for x in numbers}
    
    return squares, evens, matrix, square_dict, unique_squares

def transform_data(data):
    # Generator expression
    total = sum(x**2 for x in data)
    
    # Zip with comprehension
    pairs = [(x, y) for x, y in zip(data, data[1:])]
    
    # Enumerate with comprehension
    indexed = [(i, x) for i, x in enumerate(data)]
    
    return total, pairs, indexed

def filter_and_map(items):
    # Chained operations
    result = [x * 2 for x in [y for y in items if y > 0]]
    return result
