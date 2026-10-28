def add_numbers(a: int | float, b: int | float) -> int | float:
    """Return the sum of two numbers."""
    return a + b


if __name__ == "__main__":
    first_number = 5
    second_number = 3
    result = add_numbers(first_number, second_number)
    print(f"{first_number} + {second_number} = {result}")
