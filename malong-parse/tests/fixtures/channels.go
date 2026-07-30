// Go channels example

package main

import (
	"fmt"
	"sync"
	"time"
)

func producer(ch chan<- int, count int) {
	for i := 0; i < count; i++ {
		ch <- i
		time.Sleep(10 * time.Millisecond)
	}
	close(ch)
}

func consumer(ch <-chan int, wg *sync.WaitGroup) {
	defer wg.Done()
	for val := range ch {
		fmt.Printf("Received: %d\n", val)
	}
}

func fanOut(input <-chan int, numWorkers int) []chan int {
	channels := make([]chan int, numWorkers)
	for i := 0; i < numWorkers; i++ {
		channels[i] = make(chan int)
		go func(ch chan int) {
			for val := range input {
				ch <- val * 2
			}
			close(ch)
		}(channels[i])
	}
	return channels
}

func main() {
	ch := make(chan int, 10)
	var wg sync.WaitGroup
	
	go producer(ch, 5)
	
	wg.Add(1)
	go consumer(ch, &wg)
	
	wg.Wait()
}
