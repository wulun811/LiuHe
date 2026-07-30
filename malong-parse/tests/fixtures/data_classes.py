from dataclasses import dataclass
from typing import List, Optional

@dataclass
class Point:
    x: float
    y: float

@dataclass
class Rectangle:
    top_left: Point
    bottom_right: Point
    
    def area(self) -> float:
        w = self.bottom_right.x - self.top_left.x
        h = self.bottom_right.y - self.top_left.y
        return abs(w * h)

def create_unit_square() -> Rectangle:
    return Rectangle(Point(0, 0), Point(1, 1))
