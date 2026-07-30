package main

import "fmt"

type Point struct {
    X, Y float64
}

func (p Point) Distance() float64 {
    return p.X*p.X + p.Y*p.Y
}

type Line struct {
    Start, End Point
}

func (l Line) Length() float64 {
    dx := l.End.X - l.Start.X
    dy := l.End.Y - l.Start.Y
    return dx*dx + dy*dy
}

func NewPoint(x, y float64) Point {
    return Point{X: x, Y: y}
}

func main() {
    p1 := NewPoint(0, 0)
    p2 := NewPoint(3, 4)
    line := Line{Start: p1, End: p2}
    fmt.Println(line.Length())
}
