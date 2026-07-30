// Go slices and maps example

package main

import "fmt"

func processSlice(numbers []int) (sum int, avg float64) {
	sum = 0
	for _, n := range numbers {
		sum += n
	}
	if len(numbers) > 0 {
		avg = float64(sum) / float64(len(numbers))
	}
	return
}

func filterSlice(numbers []int, predicate func(int) bool) []int {
	result := make([]int, 0)
	for _, n := range numbers {
		if predicate(n) {
			result = append(result, n)
		}
	}
	return result
}

func mapSlice(numbers []int, transform func(int) int) []int {
	result := make([]int, len(numbers))
	for i, n := range numbers {
		result[i] = transform(n)
	}
	return result
}

func countWords(text string) map[string]int {
	words := make(map[string]int)
	// Simple word counting
	start := 0
	for i, ch := range text {
		if ch == ' ' {
			if i > start {
				word := text[start:i]
				words[word]++
			}
			start = i + 1
		}
	}
	if start < len(text) {
		words[text[start:]]++
	}
	return words
}

func main() {
	numbers := []int{1, 2, 3, 4, 5}
	sum, avg := processSlice(numbers)
	fmt.Printf("Sum: %d, Avg: %.2f\n", sum, avg)
	
	evens := filterSlice(numbers, func(n int) bool { return n%2 == 0 })
	fmt.Printf("Evens: %v\n", evens)
	
	doubled := mapSlice(numbers, func(n int) int { return n * 2 })
	fmt.Printf("Doubled: %v\n", doubled)
}
