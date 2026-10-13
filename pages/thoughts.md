---
layout: thoughts
title: Thoughts
permalink: /thoughts/
---

<ul class="post-list">
    {% for post in site.posts %}
        {% unless post.tags contains "draft" %}
        <li class="post-item">
            <a href="{{ post.url }}" class="post-link">
                <time class="post-date" datetime="{{ post.date | date_to_xmlschema }}">
                    {{ post.date | date: "%B %-d, %Y" }}
                </time>
                <h2 class="post-title">
                    {{ post.title }}
                </h2>
                {% if post.tags %}
                    <div class="post-tags">
                        {% for tag in post.tags %}
                            <span class="tag">{{ tag }}</span>
                        {% endfor %}
                    </div>
                {% endif %}
                {% if post.description %}
                    <div class="post-description">{{ post.description }}</div>
                {% endif %}
                {% assign word_count = post.content | strip_html | number_of_words %}
                {% assign read_time = word_count | plus: 199 | divided_by: 200 %}
                {% if read_time < 1 %}
                    {% assign read_time = 1 %}
                {% endif %}
                <div class="post-read-time">{{ read_time }} min read</div>
            </a>
        </li>
        {% endunless %}
    {% endfor %}
</ul>
