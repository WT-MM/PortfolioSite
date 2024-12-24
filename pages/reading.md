---
layout: default
title: Reading List
permalink: /reading/
custom_css: reading.css
---

<div class="container d-flex flex-column align-items-center">
  {% for category in site.data.books %}
    <h2 class="label">{{ category.name }}</h2>
    <div class="book-grid">
      {% for book in category.books %}
        <div class="covercontainer">
          <img class="book" src="/assets/images/books/{{ book.cover }}" alt="{{ book.title }}">
        </div>  
      {% endfor %}
    </div>
  {% endfor %}
</div>
