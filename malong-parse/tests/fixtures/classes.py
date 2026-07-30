# Python classes example

class Animal:
    def __init__(self, name: str):
        self.name = name
    
    def speak(self) -> str:
        return f"{self.name} makes a sound"

class Dog(Animal):
    def __init__(self, name: str, breed: str):
        super().__init__(name)
        self.breed = breed
    
    def speak(self) -> str:
        return f"{self.name} barks"
    
    def fetch(self, item: str) -> str:
        return f"{self.name} fetches {item}"

class Cat(Animal):
    def __init__(self, name: str, indoor: bool = True):
        super().__init__(name)
        self.indoor = indoor
    
    def speak(self) -> str:
        return f"{self.name} meows"
    
    def purr(self) -> str:
        if self.indoor:
            return f"{self.name} purrs contentedly"
        return f"{self.name} purrs"

def create_pet(pet_type: str, name: str) -> Animal:
    if pet_type == "dog":
        return Dog(name, "Labrador")
    elif pet_type == "cat":
        return Cat(name, True)
    return Animal(name)
