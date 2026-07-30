# Python error handling example

class CustomError(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code

class ValidationError(CustomError):
    def __init__(self, field, message):
        super().__init__(f"Validation failed for {field}: {message}", 400)
        self.field = field

def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b

def safe_divide(a, b):
    try:
        return divide(a, b)
    except ValueError as e:
        print(f"Error: {e}")
        return None
    except TypeError as e:
        print(f"Type error: {e}")
        return None
    finally:
        print("Division attempted")

def process_data(data):
    try:
        if not isinstance(data, dict):
            raise TypeError("Data must be a dictionary")
        
        if 'value' not in data:
            raise ValidationError('value', 'Missing required field')
        
        result = divide(data['value'], data.get('divisor', 1))
        return {'success': True, 'result': result}
        
    except ValidationError as e:
        return {'success': False, 'error': str(e), 'code': e.code}
    except Exception as e:
        return {'success': False, 'error': str(e)}
