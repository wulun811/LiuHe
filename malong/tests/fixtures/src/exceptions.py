class ValidationError(Exception):
    pass


def validate_age(age):
    if age < 0:
        raise ValueError(
            "age must be non-negative"
        )
    if age > 150:
        raise ValueError("age too large")
    return True


def validate_name(name):
    if not name:
        raise ValidationError("name is required")
    return True
