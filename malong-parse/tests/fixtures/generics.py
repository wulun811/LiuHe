# Python generics example

from typing import TypeVar, Generic, List, Optional

T = TypeVar('T')

class Stack(Generic[T]):
    def __init__(self) -> None:
        self._items: List[T] = []
    
    def push(self, item: T) -> None:
        self._items.append(item)
    
    def pop(self) -> Optional[T]:
        if self._items:
            return self._items.pop()
        return None
    
    def peek(self) -> Optional[T]:
        if self._items:
            return self._items[-1]
        return None
    
    def is_empty(self) -> bool:
        return len(self._items) == 0

def first_item(items: List[T]) -> Optional[T]:
    if items:
        return items[0]
    return None

def last_item(items: List[T]) -> Optional[T]:
    if items:
        return items[-1]
    return None
